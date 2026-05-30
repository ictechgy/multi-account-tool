/**
 * Linux Secret Service (secret-tool / libsecret) source 구현.
 *
 * macOS Keychain (sources.ts) 의 backup→delete→add→rollback 패턴을 미러하되,
 * docker 에서 실측한 secret-tool 시맨틱(docker/README.md)에 맞춘다:
 *  - `search --all`: block-header `[/N]`·`label`·`secret` 은 **stdout**,
 *    `attribute.<key>` 는 **stderr** 로 분리된다. N 카운트는 stdout 의 `[/N]`
 *    헤더 출현 횟수(secret 내용/멀티라인 비의존), account 역조회는 stderr 의
 *    `attribute.account`.
 *  - 부재 = **exit 0 + 빈 출력** (exit code 로 부재 판정 불가). exit code≠0 은
 *    미설치(spawn ENOENT) 또는 daemon-down 으로 구분해 throw.
 *  - `store` 는 **upsert**(덮어쓰기), value 는 **stdin**(argv 미노출, PR-3a).
 *  - `clear` 는 **deletes-all** — service+account 2-attribute 매칭은 실측상
 *    단일 삭제지만, backup 단계에서 N>1 을 거부해 sibling 파괴를 차단한다.
 *
 * 보안: secret 은 stdin 으로만 전달하고, parse-failure 에러에는 raw search
 * 출력(stdout 의 secret 포함)을 절대 넣지 않는다 — 구조적 메시지만 surface.
 */

import { runCommand, type CmdResult } from './sources.js';
import { OsKeyringAccountMissingError, redactMessage } from './errors.js';
import type { KeychainStored, OsKeyringSource } from './types.js';

/** Linux `secret-tool` 절대경로. PATH shim 공격을 방지 (SECURITY_BIN 미러). */
const SECRET_TOOL_BIN = '/usr/bin/secret-tool';

/** search 결과 1건 backup — value + account(역조회, 없을 수 있음). */
interface OsKeyringBackup {
  value: string;
  account: string | null;
}

/**
 * account 의 유효성 type-guard (sources.ts hasAccount 미러).
 * 빈 문자열 / NUL 포함은 "잘못된 입력" 으로 취급 — service-only fallthrough 차단.
 */
function hasAccount(account?: string): account is string {
  return typeof account === 'string' && account.length > 0 && !account.includes('\x00');
}

/**
 * OsKeyringSource 의 source-boundary 검증 (assertValidKeychainSource 미러).
 * `account` 가 정의됐는데 유효하지 않으면 명시 throw — service-only 조회로
 * multi-account scope 가 silent 하게 깨지는 것을 차단한다.
 */
function assertValidOsKeyringSource(src: OsKeyringSource): void {
  if (src.account !== undefined && !hasAccount(src.account)) {
    throw new Error(
      `OsKeyringSource.account 가 유효하지 않습니다 (빈 문자열 / NUL 포함 등): service=${src.service}`
    );
  }
}

/**
 * 미설치 / daemon-down 을 구분한 에러. raw search 출력(secret 포함 가능)은 절대
 * 포함하지 않는다 — 구조적 메시지만 (parse-failure secret 누설 차단, plan F4).
 *
 * `runCommand` 가 spawn 실패(ENOENT 등)면 code=-1 을 반환한다 → 미설치로 판정.
 * 그 외 code≠0 은 daemon 미응답/접근 거부로 판정.
 */
function osKeyringErr(stage: string, r: CmdResult): Error {
  // 메시지에 raw output 을 넣지 않는 게 1차 방어지만, redactMessage 로도 감싸
  // 심층 방어한다 (keychainErr 와 일관 — 향후 메시지에 실수로 output 이 들어가도
  // token-shaped secret 은 redact). 구조적 메시지라 redact 가 잘라낼 내용은 없다.
  const msg = r.code === -1
    ? `os-keyring ${stage} 실패: secret-tool 을 실행할 수 없습니다 ` +
      `(${SECRET_TOOL_BIN} 미설치 또는 실행 불가). libsecret-tools 패키지 설치가 필요합니다.`
    : `os-keyring ${stage} 실패 (code=${r.code}): Secret Service keyring daemon 미응답 또는 접근 거부. ` +
      `gnome-keyring 등 keyring daemon 활성화를 확인하세요.`;
  return new Error(redactMessage(msg));
}

/** block-header `[/N]` 라인 정규식 (단독 라인). */
const BLOCK_HEADER_RE = /^\[\/[^\]]*\]$/;

/**
 * `secret-tool search --all` 의 stdout 에서 매칭 블록 수를 센다.
 *
 * block-header `[/N]` 출현 횟수가 매칭 수다. 단, secret value(멀티라인)에 정확히
 * `[/2]` 형태 단독 줄이 있으면 헤더로 오인될 수 있으므로, **헤더 다음 줄이
 * `label = ` 로 시작하는 경우에만** 카운트한다 (실측상 헤더 바로 뒤엔 항상 label).
 * 이로써 secret 내용에 의한 오카운트(→ 단일 항목의 false N>1 collision 거부)를 차단한다.
 */
function blockCount(stdout: string): number {
  const lines = stdout.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    if (BLOCK_HEADER_RE.test(lines[i]) && lines[i + 1]?.startsWith('label = ')) {
      count++;
    }
  }
  return count;
}

/**
 * 단일 블록(N=1) stdout 에서 secret value 를 추출.
 *
 * secret 은 `secret = ` 라인부터 시작하고, 블록 **끝**에 메타 라인
 * (`created`/`modified`/`schema` = )이 연속한다. 멀티라인 secret 의 중간에
 * `created = ` 처럼 보이는 줄이 있어도 조기 절단되지 않도록, **뒤에서부터** 메타
 * 라인만 벗겨내고 그 앞 전체를 secret 으로 본다 (앞에서 첫 메타 만나 break 하면
 * secret 중간의 메타-유사 줄에서 값이 잘린다).
 * `secret = ` 라인이 없으면 null (파싱 실패).
 */
function parseSingleSecret(stdout: string): string | null {
  const lines = stdout.split('\n');
  const startIdx = lines.findIndex((l) => l.startsWith('secret = '));
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  // 블록 말미의 trailing 빈 줄 + 메타 라인을 뒤에서부터 제거 (secret 보다 항상 뒤).
  while (endIdx > startIdx + 1 && lines[endIdx - 1] === '') endIdx--;
  while (endIdx > startIdx + 1 && /^(created|modified|schema) = /.test(lines[endIdx - 1])) endIdx--;
  const valueLines = [
    lines[startIdx].slice('secret = '.length),
    ...lines.slice(startIdx + 1, endIdx),
  ];
  return valueLines.join('\n');
}

/**
 * stderr 에서 첫 `attribute.account = ` 값을 추출 (N=1 backup 의 account 역조회).
 * 없으면 null.
 */
function parseSingleAccount(stderr: string): string | null {
  const m = stderr.match(/^attribute\.account = (.*)$/m);
  return m ? m[1] : null;
}

/** `secret-tool search --all service <svc> [account <acct>]` 실행. */
async function rawSearch(service: string, scopeAccount?: string): Promise<CmdResult> {
  const args = ['search', '--all', 'service', service];
  if (hasAccount(scopeAccount)) args.push('account', scopeAccount);
  return runCommand(SECRET_TOOL_BIN, args);
}

/**
 * backup 로드 (loadKeychainBackup 미러). search --all 의 0/1/N 분기:
 *  - exit code≠0 → 미설치/daemon-down throw (osKeyringErr).
 *  - N=0 → null (정상 부재; exit 0 + 빈 출력).
 *  - N>1 → OsKeyringAccountMissingError (clear deletes-all 로 인한 data loss 차단).
 *  - N=1 → { value, account }. secret 추출 실패 시 raw output 미포함 구조적 throw.
 */
async function osKeyringBackup(
  service: string,
  scopeAccount?: string
): Promise<OsKeyringBackup | null> {
  const r = await rawSearch(service, scopeAccount);
  if (r.code !== 0) throw osKeyringErr('조회', r);
  const count = blockCount(r.stdout);
  if (count === 0) return null;
  if (count > 1) throw new OsKeyringAccountMissingError(service, count);
  const value = parseSingleSecret(r.stdout);
  if (value == null) {
    // raw output(secret co-located on stdout)은 절대 포함하지 않는다 (plan F4).
    // 구조적 메시지지만 redact 로도 감싼다 (심층 방어).
    throw new Error(redactMessage('os-keyring search 결과 파싱 실패: 1 블록인데 secret 을 추출하지 못했습니다.'));
  }
  return { value, account: parseSingleAccount(r.stderr) };
}

/**
 * 항목 저장 — value 는 stdin 으로 전달(argv 미노출). label 은 service 명 재사용.
 * upsert 시맨틱이라 동일 (service, account) 는 덮어쓴다.
 */
async function osKeyringStore(service: string, account: string, value: string): Promise<CmdResult> {
  return runCommand(
    SECRET_TOOL_BIN,
    ['store', '--label', service, 'service', service, 'account', account],
    value
  );
}

/** 2-attribute(service+account) 매칭 항목 삭제 (deleteKeychainEntry 미러). */
async function osKeyringClear(service: string, account: string): Promise<void> {
  const r = await runCommand(SECRET_TOOL_BIN, ['clear', 'service', service, 'account', account]);
  if (r.code !== 0) throw osKeyringErr('항목 삭제', r);
}

/**
 * 새 항목 store + 실패 시 backup 복구 (addKeychainEntryOrRollback 미러).
 * backup 이 있고 store 가 실패하면 backup.account 로 재기록 — rollback 도 실패하면
 * 양쪽 에러를 동시 surface. 에러 메시지에 secret/raw output 은 포함하지 않는다.
 */
async function osKeyringStoreOrRollback(
  service: string,
  account: string,
  value: string,
  backup: OsKeyringBackup | null
): Promise<void> {
  const res = await osKeyringStore(service, account, value);
  if (res.code === 0) return;

  let rollbackNote = '';
  if (backup && backup.account != null) {
    const rb = await osKeyringStore(service, backup.account, backup.value);
    if (rb.code !== 0) {
      rollbackNote = ` / 백업 복구도 실패 (code=${rb.code})`;
    }
  }
  throw new Error(redactMessage(`os-keyring 쓰기 실패 (code=${res.code})${rollbackNote}`));
}

/** os-keyring source 를 직렬화된 JSON 문자열로 캡처 (readKeychainSerialized 미러). */
export async function readOsKeyringSerialized(src: OsKeyringSource): Promise<string | null> {
  assertValidOsKeyringSource(src);
  const backup = await osKeyringBackup(src.service, src.account);
  if (!backup) return null;
  const stored: KeychainStored = { value: backup.value, account: backup.account ?? undefined };
  return JSON.stringify(stored);
}

/**
 * 직렬화된 JSON 을 받아 os-keyring 항목을 복원 (writeKeychainSerialized 미러).
 *
 * account 우선순위: src.account (정의 명시) > stored.account (캡처 시 기록) >
 *   $USER > 'default'.
 *
 * 시퀀스: backup(N>1 거부) → 기존 account 항목 clear → store(new) →
 *   실패 시 backup 으로 rollback. libsecret store 는 upsert 지만, 새 account 가
 *   기존과 다르면 옛 항목이 잔류하므로 clear 단계로 macOS 와 동일하게 정리한다.
 */
export async function writeOsKeyringSerialized(src: OsKeyringSource, serialized: string): Promise<void> {
  assertValidOsKeyringSource(src);
  const stored = JSON.parse(serialized) as KeychainStored;
  // corrupt / legacy backup 방어: value 가 문자열이 아니면 store 의 stdin 에
  // 'undefined'/'null' 리터럴이 들어가는 사고를 차단 (writeKeychainSerialized 미러).
  if (typeof stored.value !== 'string') {
    throw new Error('os-keyring backup 이 손상되었습니다: value 필드가 문자열이 아닙니다.');
  }
  const account = hasAccount(src.account)
    ? src.account
    : hasAccount(stored.account)
      ? stored.account
      : process.env.USER || 'default';

  const backup = await osKeyringBackup(src.service, src.account);
  if (backup) {
    // clear/rollback 대상 account 확정: stderr 역조회 account → scope 된 src.account.
    // 둘 다 없으면 어떤 항목을 지울지 모르는 채 clear/rollback 을 건너뛰어 옛 항목이
    // 잔류(→ 다음 read 에서 N>1)하거나 rollback 이 무력화된다. macOS loadKeychainBackup
    // 이 account 미식별 시 throw 하는 것과 동일하게, blind 진행 대신 거부한다.
    const recoverAccount = backup.account ?? (hasAccount(src.account) ? src.account : null);
    if (recoverAccount == null) {
      throw new OsKeyringAccountMissingError(src.service, 1);
    }
    backup.account = recoverAccount; // rollback 도 동일 account 로 재기록되도록 확정.
    await osKeyringClear(src.service, recoverAccount);
  }
  await osKeyringStoreOrRollback(src.service, account, stored.value, backup);
}

/**
 * os-keyring 항목의 존재 여부 (keychainExists 미러).
 *
 * N>1 (collision) 은 `osKeyringBackup` 과 동일하게 `OsKeyringAccountMissingError`
 * 로 throw 한다 — sourceExists 를 validity check 로 쓰는 호출자에게 unsafe 한
 * deletes-all 상태를 true 로 숨기지 않기 위함.
 */
export async function osKeyringExists(src: OsKeyringSource): Promise<boolean> {
  assertValidOsKeyringSource(src);
  const r = await rawSearch(src.service, src.account);
  if (r.code !== 0) throw osKeyringErr('조회', r);
  const count = blockCount(r.stdout);
  if (count > 1) throw new OsKeyringAccountMissingError(src.service, count);
  return count >= 1;
}
