/**
 * Linux Secret Service (secret-tool / libsecret) source 구현.
 *
 * macOS Keychain (sources.ts) 의 backup→delete→add→rollback 패턴을 미러하되,
 * docker 에서 실측한 secret-tool 시맨틱(docker/README.md)에 맞춘다:
 *  - `search --all`: block-header `[/N]`·`label`·`secret` 은 **stdout**,
 *    `attribute.<key>` 는 **stderr** 로 분리된다. N 카운트는 stdout 의 `[/N]`
 *    헤더 출현 횟수(secret 내용/멀티라인 비의존), account 역조회는 stderr 의
 *    `attribute.account`.
 *  - 부재 = **exit 0 + 빈 출력** (exit code 로 부재 판정 불가). exit code≠0 의 처리는
 *    읽기/쓰기 경로에서 갈린다 (#59, #73):
 *      · **미설치 (spawn ENOENT → code=-1, spawnErrno='ENOENT')**: 읽기(backup/exists)는
 *        **soft-fail** — 강한 stderr 경고 1회 후 null/false 반환 → yaml fallback 도달.
 *        쓰기(store/clear)는 조용히 넘기면 안 되므로 **throw 유지** (osKeyringErr).
 *        secret-tool CLI 만 미설치인 활성 keyring 사용자는 stale yaml swap(wrong-account)
 *        위험이 있어 경고로 안내한다.
 *      · **ENOENT 아닌 spawn 실패 (EACCES 등 → code=-1, spawnErrno!=='ENOENT')**: secret-tool
 *        이 있으나 실행 권한이 없는 등 '미설치 아님' 이라, 부재로 오인해 yaml swap 하면
 *        wrong-account 위험이 의도 이상으로 확대된다. 읽기/쓰기 모두 **throw** (fail-closed, #73).
 *      · **daemon-down / 접근 거부 (code>0)**: infra 가 깨진 경우라 읽기/쓰기 모두
 *        **throw 유지** (fail-closed). tooling 만 깨진 미설치(ENOENT)와 구분한다.
 *    Goose file-backend 사용자용 명시 skip 은 source 정의(cli-defs.ts gooseUsesFileBackend)에서
 *    GOOSE_DISABLE_KEYRING 양성 증거로 처리한다 — primitive 는 부재를 추정하지 않는다 (#59).
 *  - `store` 는 **upsert**(덮어쓰기), value 는 **stdin**(argv 미노출, PR-3a).
 *  - `clear` 는 **deletes-all** — service+account 2-attribute 매칭은 실측상
 *    단일 삭제지만, backup 단계에서 N>1 을 거부해 sibling 파괴를 차단한다.
 *
 * 보안: secret 은 stdin 으로만 전달하고, parse-failure 에러에는 raw search
 * 출력(stdout 의 secret 포함)을 절대 넣지 않는다 — 구조적 메시지만 surface.
 */

import { runCommand, type CmdResult } from './sources.js';
import { OsKeyringAccountMissingError, formatServiceForDisplay, redactMessage } from './errors.js';
import type { KeychainStored, OsKeyringSource } from './types.js';

/** Linux `secret-tool` 절대경로. PATH shim 공격을 방지 (SECURITY_BIN 미러). */
const SECRET_TOOL_BIN = '/usr/bin/secret-tool';

/**
 * `secret-tool` 이 **미설치(ENOENT)** 라서 읽기 soft-fail 대상인지 판정한다 (#73).
 *
 * runCommand 는 ENOENT 뿐 아니라 EACCES(실행 권한 없음)·ENOTDIR·실행포맷 오류 등
 * **모든 spawn 실패**에 code=-1 을 반환한다. 따라서 code=-1 만으로 soft-fail 하면
 * 'secret-tool 은 있으나 실행 권한이 없는' 경우 등도 부재로 오인해 yaml swap →
 * wrong-account 위험이 의도 이상으로 확대된다. 사용자 결정은 **ENOENT(미설치)만
 * soft-fail** 이므로, spawnErrno 가 정확히 'ENOENT' 일 때만 true 를 반환한다.
 * 그 외 spawn 실패(EACCES 등)는 호출자가 fail-closed throw 한다.
 */
function isSecretToolMissing(r: CmdResult): boolean {
  return r.code === -1 && r.spawnErrno === 'ENOENT';
}

/**
 * secret-tool 미설치(ENOENT) soft-fail 경고를 프로세스당 1회만 출력하기 위한 가드.
 * read 경로(backup/exists)가 source 순회마다 호출될 수 있어, 같은 경고가 반복 노출되는
 * 것을 막는다 (호출당 1회가 아니라 모듈 레벨 1회).
 */
let secretToolMissingWarned = false;

/**
 * secret-tool(libsecret-tools) 미설치로 OS keyring 읽기에 실패해 file backend
 * (secrets.yaml) 로 fallback 함을 stderr 로 강하게 경고한다 (#59).
 *
 * **왜 강한 경고인가**: ENOENT soft-fail 은 "keyring 을 실제 사용 중인데 secret-tool
 * CLI 만 미설치" 인 사용자에게 stale yaml 로 swap 되는 wrong-account 위험을 도입한다.
 * 이를 완화하기 위해, keyring 을 실제 쓰는 중이라면 `libsecret-tools` 설치 또는
 * `GOOSE_DISABLE_KEYRING=1` 설정을 명시 안내한다. best-effort — 프로세스당 1회만 출력.
 */
function warnSecretToolMissing(): void {
  if (secretToolMissingWarned) return;
  secretToolMissingWarned = true;
  process.stderr.write(
    `[mat] 경고: secret-tool(libsecret-tools) 미설치로 OS keyring 을 읽지 못해 ` +
    `file backend(secrets.yaml)로 fallback 합니다.\n` +
    `      keyring 을 실제 사용 중이라면 stale 자격증명으로 swap 되어 wrong-account 가 될 수 있습니다. ` +
    `정확한 swap 을 위해 'libsecret-tools' 를 설치하거나, file backend 를 쓴다면 ` +
    `'GOOSE_DISABLE_KEYRING=1' 을 설정하세요.\n`
  );
}

/**
 * `secretToolMissingWarned` 모듈 가드 초기화 — **테스트 전용** (resetCliDefCache 컨벤션 미러).
 *
 * 경고는 프로세스당 1회만 출력되는 모듈 레벨 가드라, 한 테스트가 ENOENT 를 트리거하면
 * 이후 테스트에서 같은 가드가 이미 true 라 경고 검증이 불안정해진다. 테스트가 가드를
 * 명시 리셋해 '1회 출력' 동작과 '경고 내용' 을 독립적으로 검증할 수 있게 한다.
 * production 에서는 호출하지 않는다.
 */
export function resetSecretToolMissingWarnedForTest(): void {
  secretToolMissingWarned = false;
}

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
      `OsKeyringSource.account 가 유효하지 않습니다 (빈 문자열 / NUL 포함 등): service=${formatServiceForDisplay(src.service)}`
    );
  }
}

/**
 * env-secret custody 용 strict helper 는 service-only probe/mutation 을 허용하지 않는다.
 *
 * 기존 public os-keyring source 는 account 생략을 유지하지만, env-secret backend 는
 * profile-owned binding 을 accountKey 로 고정해야 하므로 strict path 에서는 조회 전부터
 * 명시 account 를 요구한다.
 */
function assertStrictOsKeyringSource(src: OsKeyringSource): void {
  assertValidOsKeyringSource(src);
  if (!hasAccount(src.account)) {
    throw new Error('os-keyring strict custody operation requires an explicit account');
  }
}

/**
 * spawn 실패(미설치 ENOENT / 권한·기타) / daemon-down 을 구분한 에러. raw search
 * 출력(secret 포함 가능)은 절대 포함하지 않는다 — 구조적 메시지만 (parse-failure
 * secret 누설 차단, plan F4).
 *
 * `runCommand` 는 **모든 spawn 실패**(ENOENT/EACCES/ENOTDIR 등)에 code=-1 을 반환하되,
 * errno 는 `spawnErrno` 로 보존한다. 따라서 code=-1 은 'ENOENT(미설치)' 와 'EACCES 등
 * 다른 spawn 실패' 둘 다일 수 있어, 메시지를 errno 로 분기한다 (#73). 그 외 code≠0 은
 * daemon 미응답/접근 거부로 판정한다.
 *
 * **읽기 vs 쓰기** (#59, #73): 읽기 경로(backup/exists)는 **ENOENT(미설치)만** soft-fail 로
 * 가로채(warnSecretToolMissing → null/false) 이 함수에 도달하지 않는다. 따라서 이 함수의
 * code=-1 분기는 (a) **쓰기 경로(store/clear)의 ENOENT** — 쓰기 실패를 조용히 넘기면
 * 자격증명 손실이라 미설치도 명시 throw — 또는 (b) **읽기/쓰기 공통의 ENOENT 아닌 spawn
 * 실패(EACCES 등)** 에서 도달한다 (읽기에서도 fail-closed throw). daemon-down(code>0)은
 * 읽기/쓰기 모두 throw.
 */
function osKeyringErr(stage: string, r: CmdResult): Error {
  // 메시지에 raw output 을 넣지 않는 게 1차 방어지만, redactMessage 로도 감싸
  // 심층 방어한다 (keychainErr 와 일관 — 향후 메시지에 실수로 output 이 들어가도
  // token-shaped secret 은 redact). 구조적 메시지라 redact 가 잘라낼 내용은 없다.
  // 미설치(ENOENT) 메시지에는 file-backend 탈출구를 함께 안내한다 — keyring 을 안 쓰는
  // 사용자가 불필요한 패키지 설치 대신 file backend 전환을 택할 수 있도록 (#59 quad-review LOW).
  // CLI-중립 문구로 둔다 (primitive 라 특정 env 명을 결합하지 않음 — CLI 별 env 는 README).
  const msg = osKeyringErrMessage(stage, r);
  return new Error(redactMessage(msg));
}

/**
 * osKeyringErr 의 메시지 빌더 — spawn 실패의 errno(ENOENT 미설치 / EACCES 등 권한·기타)
 * 와 daemon-down(code>0)을 구분해 정확한 원인·해결 방향을 안내한다 (#73).
 */
function osKeyringErrMessage(stage: string, r: CmdResult): string {
  if (r.code !== -1) {
    return `os-keyring ${stage} 실패 (code=${r.code}): Secret Service keyring daemon 미응답 또는 접근 거부. ` +
      `gnome-keyring 등 keyring daemon 활성화를 확인하세요.`;
  }
  if (r.spawnErrno === 'ENOENT') {
    return `os-keyring ${stage} 실패: secret-tool 이 미설치입니다 ` +
      `(${SECRET_TOOL_BIN} 부재, ENOENT). libsecret-tools 패키지를 설치하거나, ` +
      `해당 CLI 가 file backend(평문 파일) 모드를 지원하면 그 모드로 전환하세요 (README 참고).`;
  }
  // EACCES(실행 권한 없음)·ENOTDIR·실행포맷 오류 등 ENOENT 아닌 spawn 실패.
  // 미설치가 아니므로 패키지 설치 안내 대신 실행 권한/바이너리 점검을 안내한다 (#73).
  return `os-keyring ${stage} 실패: secret-tool 을 실행할 수 없습니다 ` +
    `(${SECRET_TOOL_BIN}, errno=${r.spawnErrno ?? '미상'}). 실행 권한 또는 바이너리 상태를 확인하세요.`;
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
 *  - 미설치 (code=-1 && spawnErrno==='ENOENT') → **soft-fail**: 강한 stderr 경고 1회 후
 *    null 반환 → readOsKeyringSerialized null → switcher 가 다음 source(secrets.yaml)로
 *    fallback (#59).
 *  - ENOENT 아닌 spawn 실패 (code=-1 && spawnErrno!=='ENOENT', EACCES 등) → throw
 *    (osKeyringErr, fail-closed — 미설치 아닌데 부재로 오인 시 wrong-account 위험, #73).
 *  - 그 외 code≠0 (daemon-down / 접근 거부) → throw (osKeyringErr, fail-closed).
 *  - N=0 → null (정상 부재; exit 0 + 빈 출력).
 *  - N>1 → OsKeyringAccountMissingError (clear deletes-all 로 인한 data loss 차단).
 *  - N=1 → { value, account }. secret 추출 실패 시 raw output 미포함 구조적 throw.
 */
type SecretToolMissingPolicy = 'soft-fail' | 'throw';

async function osKeyringBackup(
  service: string,
  scopeAccount?: string,
  missingPolicy: SecretToolMissingPolicy = 'soft-fail'
): Promise<OsKeyringBackup | null> {
  const r = await rawSearch(service, scopeAccount);
  // 미설치(ENOENT)만 tooling 이 깨진 경우 — yaml fallback 으로 진행하되 wrong-account
  // 위험을 강한 경고로 안내한다 (#59). 그 외 spawn 실패(EACCES 등, code=-1 이지만
  // spawnErrno!=='ENOENT')는 'secret-tool 이 있으나 실행 불가' 라 부재로 오인하면
  // wrong-account 위험이 의도 이상 확대된다 → fail-closed throw (#73). daemon-down
  // (code>0)도 infra 문제라 throw 유지.
  if (isSecretToolMissing(r)) {
    if (missingPolicy === 'throw') throw osKeyringErr('조회', r);
    warnSecretToolMissing();
    return null;
  }
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
 *
 * **쓰기는 모든 실패를 throw** (#73): store 가 spawn 실패(ENOENT 미설치 포함, code=-1)든
 * daemon-down(code>0)이든 `res.code !== 0` 이면 throw 한다. 읽기처럼 ENOENT 를 soft-fail
 * 하지 않는다 — 쓰기 실패를 조용히 넘기면 자격증명이 손실되기 때문이다.
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
 * env-secret 등 file fallback 이 안전하지 않은 호출자를 위한 strict read.
 *
 * 기존 `readOsKeyringSerialized` 는 secret-tool 미설치(ENOENT)를 null 로 soft-fail 해
 * Goose yaml fallback 을 보존한다. env-secret custody 에서는 backend unavailable 을
 * missing 으로 오인하거나 plaintext/file fallback 으로 흐르면 안 되므로 ENOENT 도
 * 구조적 throw 로 처리한다. raw search output 은 반환/에러에 포함하지 않는다.
 */
export async function readOsKeyringSerializedStrict(src: OsKeyringSource): Promise<string | null> {
  assertStrictOsKeyringSource(src);
  const backup = await osKeyringBackup(src.service, src.account, 'throw');
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
async function writeOsKeyringWithPolicy(
  src: OsKeyringSource,
  serialized: string,
  missingPolicy: SecretToolMissingPolicy
): Promise<void> {
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

  const backup = await osKeyringBackup(src.service, src.account, missingPolicy);
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

export async function writeOsKeyringSerialized(src: OsKeyringSource, serialized: string): Promise<void> {
  return writeOsKeyringWithPolicy(src, serialized, 'soft-fail');
}

/**
 * env-secret 등 fallback 금지 custody 호출자를 위한 strict write.
 *
 * backup 조회 단계의 ENOENT 도 soft-fail 하지 않는다. store 자체 실패는 기존처럼
 * throw 되지만, strict write 는 미설치 상태에서 file/yaml fallback 경고를 출력하지 않고
 * 곧바로 fail-closed 한다.
 */
export async function writeOsKeyringSerializedStrict(src: OsKeyringSource, serialized: string): Promise<void> {
  assertStrictOsKeyringSource(src);
  return writeOsKeyringWithPolicy(src, serialized, 'throw');
}

/**
 * os-keyring 항목의 존재 여부 (keychainExists 미러).
 *
 * 미설치(code=-1 && spawnErrno==='ENOENT') 는 `osKeyringBackup` 과 동일하게 soft-fail —
 * 강한 stderr 경고 1회 후 **false**(부재로 간주) 반환해 yaml fallback 을 막지 않는다 (#59).
 * ENOENT 아닌 spawn 실패(EACCES 등)·daemon-down(code>0)은 throw 유지 (fail-closed, #73).
 *
 * N>1 (collision) 은 `osKeyringBackup` 과 동일하게 `OsKeyringAccountMissingError`
 * 로 throw 한다 — sourceExists 를 validity check 로 쓰는 호출자에게 unsafe 한
 * deletes-all 상태를 true 로 숨기지 않기 위함.
 */
export async function osKeyringExists(src: OsKeyringSource): Promise<boolean> {
  assertValidOsKeyringSource(src);
  const r = await rawSearch(src.service, src.account);
  // osKeyringBackup 과 동일 정책 — ENOENT(미설치)만 soft-fail(false), 그 외 spawn
  // 실패(EACCES 등)·daemon-down 은 throw (#73). 부재(N=0)와 미설치를 혼동하지 않게.
  if (isSecretToolMissing(r)) {
    warnSecretToolMissing();
    return false;
  }
  if (r.code !== 0) throw osKeyringErr('조회', r);
  const count = blockCount(r.stdout);
  if (count > 1) throw new OsKeyringAccountMissingError(src.service, count);
  return count >= 1;
}

/**
 * env-secret custody 용 strict exists/probe.
 *
 * 기존 `osKeyringExists` 는 secret-tool ENOENT 를 false 로 soft-fail 해 file backend
 * fallback 을 막지 않는다. strict exists 는 ENOENT/EACCES/daemon-down 을 모두 throw
 * 해 backend unavailable/denied 상태를 missing 으로 오인하지 않게 한다.
 */
export async function osKeyringExistsStrict(src: OsKeyringSource): Promise<boolean> {
  assertStrictOsKeyringSource(src);
  const r = await rawSearch(src.service, src.account);
  if (r.code !== 0) throw osKeyringErr('조회', r);
  const count = blockCount(r.stdout);
  if (count > 1) throw new OsKeyringAccountMissingError(src.service, count);
  return count >= 1;
}

export type OsKeyringDeleteResult = 'deleted' | 'missing';

/**
 * env-secret custody 용 strict delete/cleanup.
 *
 * - missing 은 idempotent cleanup 으로 `missing` 반환.
 * - ENOENT/EACCES/daemon-down 은 throw (fallback 금지).
 * - account 생략/N>1/account 미식별 상태는 throw (wrong-entry 삭제 차단).
 * - raw backend output/secret value 는 반환하지 않는다.
 */
export async function deleteOsKeyringSerializedStrict(src: OsKeyringSource): Promise<OsKeyringDeleteResult> {
  assertStrictOsKeyringSource(src);
  const backup = await osKeyringBackup(src.service, src.account, 'throw');
  if (!backup) return 'missing';
  const account = backup.account ?? (hasAccount(src.account) ? src.account : null);
  if (account == null) {
    throw new OsKeyringAccountMissingError(src.service, 1);
  }
  await osKeyringClear(src.service, account);
  return 'deleted';
}
