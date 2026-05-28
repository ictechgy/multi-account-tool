/**
 * Source 추상화: 파일 또는 macOS Keychain 항목을 동일한 인터페이스로 읽고 쓴다.
 *
 * Keychain 항목은 디스크에 JSON ({@link KeychainStored}) 으로 직렬화되어
 * 보관되므로 readSource / writeSource 는 모든 source 종류에 대해 string 만 다룬다.
 *
 * 안전 원칙:
 * - 파일 쓰기는 io-atomic 의 writeFileAtomic 사용 (O_EXCL + O_NOFOLLOW + 0600).
 * - Keychain 쓰기는 기존 값을 메모리에 백업 → 정확한 acct 매칭 delete → add.
 *   add 실패 시 백업으로 자동 롤백 (자격증명 영구 손실 방지).
 * - 외부 명령은 절대경로 `/usr/bin/security` 만, 인자 배열 spawn (셸 미경유).
 * - 에러 메시지는 errors.ts 의 redactMessage 로 토큰 누설 방지.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { expandTilde } from './paths.js';
import { KeychainAccountMissingError, redactMessage } from './errors.js';
import { writeFileAtomic } from './io-atomic.js';
import type { KeychainSource, KeychainStored, Source } from './types.js';

/** macOS 의 `security` CLI 절대경로. PATH shim 공격을 방지. */
const SECURITY_BIN = '/usr/bin/security';

/** `security` CLI 가 "항목 없음" 일 때 반환하는 종료 코드 (errSecItemNotFound 매핑). */
const KEYCHAIN_NOT_FOUND_CODE = 44;

/** "could not be found" stderr 패턴 (코드 변동에 대비한 보조 매칭). */
const KEYCHAIN_NOT_FOUND_RE = /could not be found/i;

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * 외부 명령을 spawn 으로 안전하게 실행.
 * error/close 이벤트가 모두 발생할 수 있으므로 settled 가드로 단일 resolve 보장.
 */
function runCommand(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (code: number, errMsg?: string): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr: errMsg ?? stderr });
    };
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => settle(-1, err.message));
    proc.on('close', (code) => settle(code ?? -1));
  });
}

function keychainErr(stage: string, r: CmdResult): Error {
  return new Error(`keychain ${stage} 실패 (code=${r.code}): ${redactMessage(r.stderr || r.stdout)}`);
}

/**
 * KeychainSource.account 의 유효성 type-guard.
 * 빈 문자열 / NUL 포함 문자열은 undefined 와 동치가 아니라 "잘못된 입력" 으로 취급.
 * 외부 입력 (cli-defs-plugin.parseSource) 과 internal 호출 모두 동일 invariant 적용.
 *
 * type guard 는 narrowing 외에 "유효 여부" 만 알린다 — `assertValidKeychainSource`
 * 가 source 진입부에서 명시 throw 로 invariant 누설을 차단한다 (quad-review 합의).
 */
function hasAccount(account?: string): account is string {
  return typeof account === 'string' && account.length > 0 && !account.includes('\x00');
}

/**
 * KeychainSource 의 source-boundary 검증.
 *
 * `account` 가 정의되었는데 유효한 문자열이 아니면 (빈 문자열, NUL 포함 등)
 * 명시 throw — 그렇지 않으면 mat 내부 helper 의 `hasAccount` 가드가 false 로
 * 떨어져 `-a` 인자 없이 service-only lookup 으로 진행, multi-account scope 가
 * silent 하게 깨진다 (quad-review HIGH 합의).
 *
 * read / write / sourceExists 의 keychain 분기 진입부에서 호출한다.
 */
function assertValidKeychainSource(src: KeychainSource): void {
  if (src.account !== undefined && !hasAccount(src.account)) {
    throw new Error(
      `KeychainSource.account 가 유효하지 않습니다 (빈 문자열 / NUL 포함 등): service=${src.service}`
    );
  }
}

/**
 * macOS Keychain 항목의 account (acct) 메타데이터 조회.
 * `expectedAccount` 가 주어지면 `-a` 인자로 lookup 을 scope — 동일 service 의
 * 타 account 항목이 자동 감지로 잘못 잡히는 wrong-entry 위험을 차단.
 * 항목이 없거나 acct 가 빈 문자열이면 null.
 */
async function keychainGetAccount(service: string, expectedAccount?: string): Promise<string | null> {
  const args = ['find-generic-password', '-s', service];
  if (hasAccount(expectedAccount)) args.push('-a', expectedAccount);
  const r = await runCommand(SECURITY_BIN, args);
  if (r.code !== 0) return null;
  const m = r.stdout.match(/"acct"<blob>="([^"]*)"/);
  const acct = m?.[1];
  return acct && acct.length > 0 ? acct : null;
}

/**
 * macOS Keychain 항목의 평문 값 조회. 없으면 null, 다른 에러는 throw.
 * `account` 가 주어지면 `-a` 인자로 항목 lookup 을 scope.
 */
async function keychainGetValue(service: string, account?: string): Promise<string | null> {
  const args = ['find-generic-password', '-s', service];
  if (hasAccount(account)) args.push('-a', account);
  args.push('-w');
  const r = await runCommand(SECURITY_BIN, args);
  if (r.code === 0) return r.stdout.replace(/\n$/, '');
  if (r.code === KEYCHAIN_NOT_FOUND_CODE || KEYCHAIN_NOT_FOUND_RE.test(r.stderr)) return null;
  throw keychainErr('읽기', r);
}

/**
 * Keychain 항목을 안전하게 쓴다 — orchestrator. 실제 4 책임은 3 helper 로 분리됨
 * (PR-P: 책임 ≤10 lines 가이드 + 컴파일타임 invariant 강제).
 *  1) `loadKeychainBackup`: 기존 값+account 메모리 백업. account 미식별 시 throw —
 *     service-only 삭제로 인한 타 entry 영구 손실 차단 (data loss 방지).
 *  2) `deleteKeychainEntry`: 백업 acct 와 정확히 매칭되는 항목만 삭제 (-a 명시).
 *  3) `addKeychainEntryOrRollback`: 새 값 add. 실패 시 backup 으로 자동 rollback,
 *     rollback 도 실패하면 양쪽 에러 동시 surface.
 *
 * `scopeAccount` 가 지정되면 백업 lookup/삭제 모두 `-a scopeAccount` 항목 하나로
 * 제한 — 동일 service 의 타 account 항목은 건드리지 않는다 (multi-account 안전).
 * 미지정 시 단일-account 사용자 전제로 service-only lookup (기존 동작 유지).
 *
 * 보안 invariant (helper 도 보존): `-A` ACL (Claude 가 토큰을 못 읽는 회귀 방지),
 * argv 노출 trade-off 는 README 의 "보안" 섹션 참고.
 */
async function keychainSet(
  service: string,
  account: string,
  value: string,
  scopeAccount?: string
): Promise<void> {
  const backup = await loadKeychainBackup(service, scopeAccount);
  if (backup) {
    await deleteKeychainEntry(service, backup.account);
  }
  await addKeychainEntryOrRollback(service, account, value, backup);
}

/** 백업 메타 — 존재하는 항목의 value + account. KeychainAccountMissingError 차단 동반. */
interface KeychainBackup {
  value: string;
  account: string;
}

/**
 * 기존 keychain 항목의 backup 로드 (PR-P 책임 1 — read backup).
 *
 * value 가 존재하지만 account 를 식별할 수 없으면 `KeychainAccountMissingError` —
 * blind delete 로 wrong-entry 삭제할 위험 차단 (PR #10 보안 fix 의 invariant).
 */
async function loadKeychainBackup(
  service: string,
  scopeAccount?: string
): Promise<KeychainBackup | null> {
  const value = await keychainGetValue(service, scopeAccount);
  if (value == null) return null;
  const account = await keychainGetAccount(service, scopeAccount);
  if (!account) throw new KeychainAccountMissingError(service);
  return { value, account };
}

/** keychain 항목 삭제 (PR-P 책임 2 — delete). 실패 시 keychainErr 로 surface. */
async function deleteKeychainEntry(service: string, account: string): Promise<void> {
  const delRes = await runCommand(SECURITY_BIN, [
    'delete-generic-password', '-s', service, '-a', account
  ]);
  if (delRes.code !== 0) {
    throw keychainErr('백업 항목 삭제', delRes);
  }
}

/**
 * 새 keychain 항목 add + 실패 시 backup 복구 (PR-P 책임 3+4 — add + rollback).
 *
 * `-A` 로 동일 사용자 모든 앱 접근 가능한 ACL 사용 (Claude 가 토큰을 못 읽는 회귀 방지).
 * argv 노출 trade-off 는 README 의 "보안" 섹션 참고.
 *
 * backup 이 있고 add 가 실패하면 backup 을 같은 명령으로 재기록 — rollback 도 실패하면
 * 양쪽 에러 동시 surface (단일 throw 에 rollbackNote append).
 */
async function addKeychainEntryOrRollback(
  service: string,
  account: string,
  value: string,
  backup: KeychainBackup | null
): Promise<void> {
  const addRes = await runCommand(SECURITY_BIN, [
    'add-generic-password', '-s', service, '-a', account, '-w', value, '-A'
  ]);
  if (addRes.code === 0) return;

  // backup 이 있으면 자동 rollback 시도. KeychainBackup 의 invariant (account truthy) 는
  // loadKeychainBackup 이 KeychainAccountMissingError 로 이미 검증.
  let rollbackNote = '';
  if (backup) {
    const rb = await runCommand(SECURITY_BIN, [
      'add-generic-password', '-s', service, '-a', backup.account, '-w', backup.value, '-A'
    ]);
    if (rb.code !== 0) {
      rollbackNote = ` / 백업 복구도 실패 (code=${rb.code}): ${redactMessage(rb.stderr)}`;
    }
  }
  throw new Error(
    `keychain 쓰기 실패 (code=${addRes.code}): ${redactMessage(addRes.stderr || addRes.stdout)}${rollbackNote}`
  );
}

/** Keychain 항목 존재 여부. account 지정 시 해당 acct 항목만 검사. */
async function keychainExists(service: string, account?: string): Promise<boolean> {
  const args = ['find-generic-password', '-s', service];
  if (hasAccount(account)) args.push('-a', account);
  const r = await runCommand(SECURITY_BIN, args);
  return r.code === 0;
}

/** Keychain source 를 직렬화된 JSON 문자열로 캡처 (저장용). */
async function readKeychainSerialized(src: KeychainSource): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('keychain source 는 macOS 에서만 지원됩니다.');
  }
  assertValidKeychainSource(src);
  const value = await keychainGetValue(src.service, src.account);
  if (value == null) return null;
  const account = await keychainGetAccount(src.service, src.account);
  const stored: KeychainStored = { value, account: account ?? undefined };
  return JSON.stringify(stored);
}

/**
 * 직렬화된 JSON 을 받아 Keychain 항목을 복원.
 *
 * 새 항목의 account 우선순위: src.account (정의 명시) > stored.account
 *   (백업 캡처 시 기록) > $USER > 'default'.
 *   `src.account` 가 정의된 경우 (Goose/Copilot 류 multi-account 도구), 캡처
 *   당시 stored.account 가 다르더라도 정의가 의도한 account 로 복원한다.
 *
 * 백업/삭제 scope: src.account 가 지정되면 동일 account 항목 하나만 대상.
 *   동일 service 의 타 account 항목은 보호된다.
 */
async function writeKeychainSerialized(src: KeychainSource, serialized: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('keychain source 는 macOS 에서만 지원됩니다.');
  }
  assertValidKeychainSource(src);
  const stored = JSON.parse(serialized) as KeychainStored;
  // corrupt / legacy backup 방어: value 가 문자열이 아니면 add-generic-password 의 -w
  // argv 가 'undefined' 또는 'null' 리터럴로 build 되는 사고를 차단.
  if (typeof stored.value !== 'string') {
    throw new Error('keychain backup 이 손상되었습니다: value 필드가 문자열이 아닙니다.');
  }
  // 우선순위: src.account (정의 명시) > stored.account (캡처 시 기록) > $USER > 'default'.
  // hasAccount 로 빈 문자열 fallthrough 방지 — internal 호출에 빈 문자열이 들어와도
  // service-only fallback 으로 떨어지지 않고 명확히 다음 우선순위로 진행한다.
  const account = hasAccount(src.account)
    ? src.account
    : hasAccount(stored.account)
      ? stored.account
      : process.env.USER || 'default';
  await keychainSet(src.service, account, stored.value, src.account);
}

/** 파일을 읽어 문자열 반환. 없으면 null. */
async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(expandTilde(path), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 파일 존재 여부. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(expandTilde(path));
    return true;
  } catch {
    return false;
  }
}

/** 임의 source 의 현재 라이브 값을 캡처해 문자열로 반환 (저장 가능한 형태). */
export async function readSource(src: Source): Promise<string | null> {
  if (src.type === 'file') return readFileOrNull(src.path);
  return readKeychainSerialized(src);
}

/** 임의 source 에 저장된 문자열을 라이브 위치로 복원. */
export async function writeSource(src: Source, value: string): Promise<void> {
  if (src.type === 'file') return writeFileAtomic(expandTilde(src.path), value);
  return writeKeychainSerialized(src, value);
}

/** 임의 source 의 라이브 존재 여부. */
export async function sourceExists(src: Source): Promise<boolean> {
  if (src.type === 'file') return fileExists(src.path);
  assertValidKeychainSource(src);
  return keychainExists(src.service, src.account);
}
