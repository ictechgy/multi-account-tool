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

import { constants, promises as realFs } from 'node:fs';
import { basename, dirname, relative, sep } from 'node:path';
import { expandTilde } from './paths.js';
import { resolvePathIdentity, resolvedHome } from './path-identity.js';
import { assertSourceMayBeAccessed } from './live-resource-guard.js';
import { isAdmittedGooseProviderCacheFile } from './goose-provider-cache.js';
import { KeychainAccountMissingError, formatServiceForDisplay, redactMessage } from './errors.js';
import { unsupportedEnvSecretSource } from './env-secret-source.js';
import { writeFileAtomic } from './io-atomic.js';
import { directorySourceExists, readDirectorySource, removeDirectorySource, writeDirectorySource } from './directory-source.js';
import { readOsKeyringSerialized, writeOsKeyringSerialized, osKeyringExists } from './os-keyring.js';
import { runCommand, type CmdResult } from './run-command.js';
import {
  readWindowsCredentialSourceSerialized,
  windowsCredentialSourceExists,
  writeWindowsCredentialSourceSerialized
} from './windows-credential-source.js';
import type { DirectorySource, FileSource, KeychainSource, KeychainStored, Source } from './types.js';
import { removePinnedChild } from './pinned-remove.js';
import { writePinnedProviderFile } from './pinned-write.js';

export { runCommand };
export type { CmdResult };

type SourceFsOps = typeof realFs;
let fs: SourceFsOps = realFs;

/** Deterministic provider-file fault/race injection seam. Tests must restore with `null`. */
export function __setSourceFsOpsForTests(overrides: Partial<SourceFsOps> | null): void {
  fs = overrides ? Object.assign(Object.create(realFs) as SourceFsOps, overrides) : realFs;
}

function providerPublicError(err: unknown): Error {
  const safe = err instanceof Error && /^(?:unsafe Goose provider cache (?:file|parent|temporary|activation)|Goose provider cache (?:identity|parent identity|target identity|activation identity) changed)$/.test(err.message);
  if (safe) return err as Error;
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? ` (${err.code})` : '';
  return new Error(`Goose provider cache filesystem operation failed${code}`);
}

/**
 * provider 캐시 경로를 **한 번만** 해석하고, 이후 판정과 I/O 가 그 결과 **하나만** 쓰게 한다.
 *
 * 두 표기를 섞으면 조용히 깨진다. `validateProviderParents` 는 해석된 HOME 에서 걸어 내려오며
 * 부모 목록을 만드는데, 대상 경로가 선언 표기 그대로면 마지막 부모(`parents.at(-1).path`)와
 * `dirname(선언 표기)` 가 달라진다. 두 곳(`checkedProviderWriteImpl`, `removeGooseProviderFile`)이
 * 바로 그 둘을 비교해 `Goose provider cache parent identity changed` 를 던지므로, `~/.config` 를
 * symlink 로 관리하는 **모든** 사용자의 goose 쓰기가 실패한다.
 *
 * `unresolvable`(EACCES/ELOOP 등)은 거부다 — 공격자가 해석을 실패시키기만 하면 통과하는
 * fail-open 을 막는다.
 */
async function resolveProviderPath(src: FileSource): Promise<string> {
  const id = await resolvePathIdentity(src.path);
  if (id.kind === 'unresolvable') throw new Error('unsafe Goose provider cache parent');
  return id.path;
}

/** macOS 의 `security` CLI 절대경로. PATH shim 공격을 방지. */
const SECURITY_BIN = '/usr/bin/security';

/** `security` CLI 가 "항목 없음" 일 때 반환하는 종료 코드 (errSecItemNotFound 매핑). */
const KEYCHAIN_NOT_FOUND_CODE = 44;

/** "could not be found" stderr 패턴 (코드 변동에 대비한 보조 매칭). */
const KEYCHAIN_NOT_FOUND_RE = /could not be found/i;

/** macOS Keychain all-app ACL(`security -A`)을 강제 허용/제한하는 운영자 override. */
const KEYCHAIN_ALLOW_ANY_APP_ENV = 'MAT_KEYCHAIN_ALLOW_ANY_APP';
const KEYCHAIN_RESTRICT_ACL_ENV = 'MAT_KEYCHAIN_RESTRICT_ACL';

/**
 * discriminated union 의 모든 case 처리를 컴파일 타임에 강제하는 헬퍼.
 * switch 의 default 분기에서 호출하면 Source 에 새 type 이 추가될 때
 * TypeScript 가 컴파일 에러를 발생시켜 누락된 case 를 즉시 감지한다.
 *
 * 정상 경로에선 도달 불가하지만, 잘못된 입력이 런타임에 도달했을 때 source 객체
 * 전체를 직렬화하면 service/account 같은 식별자가 에러 메시지에 노출된다. 따라서
 * discriminant(type) 만 surface 한다 (mat 의 PII 마스킹 정책과 일관).
 */
function assertNever(x: never): never {
  const type = (x as { type?: unknown }).type;
  throw new Error('처리되지 않은 source type: ' + String(type));
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
      `KeychainSource.account 가 유효하지 않습니다 (빈 문자열 / NUL 포함 등): service=${formatServiceForDisplay(src.service)}`
    );
  }
}

function envFlagEnabled(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value?.toLowerCase() === 'true';
}

function keychainAllowAnyApp(srcAllowsAnyApp: boolean | undefined): boolean {
  if (envFlagEnabled(KEYCHAIN_ALLOW_ANY_APP_ENV)) return true;
  if (envFlagEnabled(KEYCHAIN_RESTRICT_ACL_ENV)) return false;
  return srcAllowsAnyApp === true;
}

function keychainAddArgs(service: string, account: string, value: string, srcAllowsAnyApp?: boolean): string[] {
  const args = ['add-generic-password', '-s', service, '-a', account, '-w', value];
  if (keychainAllowAnyApp(srcAllowsAnyApp)) args.push('-A');
  return args;
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
 * 보안 invariant (helper 도 보존): built-in source 가 `allowAnyApp` 을 명시한 경우
 * 기존 upstream CLI 호환을 위해 `-A` ACL 을 유지한다. 운영자는
 * `MAT_KEYCHAIN_RESTRICT_ACL=1` 로 제한 모드를 강제할 수 있다.
 * `/usr/bin/security -w value` argv 노출 trade-off 는 README 의 "보안" 섹션 참고.
 */
async function keychainSet(
  service: string,
  account: string,
  value: string,
  scopeAccount?: string,
  srcAllowsAnyApp?: boolean
): Promise<void> {
  const backup = await loadKeychainBackup(service, scopeAccount);
  if (backup) {
    await deleteKeychainEntry(service, backup.account);
  }
  await addKeychainEntryOrRollback(service, account, value, backup, srcAllowsAnyApp);
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
 * built-in source 가 `allowAnyApp` 을 명시한 경우 기존 upstream CLI 호환을 위해
 * `-A` 로 동일 사용자 모든 앱 접근 ACL 을 유지한다. `MAT_KEYCHAIN_RESTRICT_ACL=1` 로
 * 제한 모드를 강제하거나, `MAT_KEYCHAIN_ALLOW_ANY_APP=1` 로 사용자/plugin source 도
 * broad ACL 을 명시 허용할 수 있다.
 * `/usr/bin/security -w value` argv 노출 trade-off 는 README 의 "보안" 섹션 참고.
 *
 * backup 이 있고 add 가 실패하면 backup 을 같은 명령으로 재기록 — rollback 도 실패하면
 * 양쪽 에러 동시 surface (단일 throw 에 rollbackNote append).
 */
async function addKeychainEntryOrRollback(
  service: string,
  account: string,
  value: string,
  backup: KeychainBackup | null,
  srcAllowsAnyApp?: boolean
): Promise<void> {
  const addRes = await runCommand(SECURITY_BIN, keychainAddArgs(service, account, value, srcAllowsAnyApp));
  if (addRes.code === 0) return;

  // backup 이 있으면 자동 rollback 시도. KeychainBackup 의 invariant (account truthy) 는
  // loadKeychainBackup 이 KeychainAccountMissingError 로 이미 검증.
  let rollbackNote = '';
  if (backup) {
    const rb = await runCommand(SECURITY_BIN, keychainAddArgs(service, backup.account, backup.value, srcAllowsAnyApp));
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
  await keychainSet(src.service, account, stored.value, src.account, src.allowAnyApp);
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

/**
 * provider 캐시 파일 하드닝 경로를 타야 하는 source 인지.
 *
 * 문자열 prefix 판정을 쓰지 않는다 — 0.8.0 의 prefix `~/.config/goose/providers/` 는 업스트림에
 * 없는 세그먼트를 요구해서 실제 캐시를 **한 번도 매칭하지 못했고**, 정정된 경로는 `secrets.yaml`
 * /`config.yaml` 과 같은 디렉토리 직하에 있으므로 prefix 를 넓히면 두 YAML 까지 하드닝 경로로
 * 삼켜 기존 동작을 반전시킨다. 따라서 goose-provider-cache.ts 의 정확 집합 멤버십으로 판정한다.
 */
function isGooseProviderFile(src: FileSource): boolean {
  return isAdmittedGooseProviderCacheFile(src.path);
}

async function checkedProviderReadImpl(src: FileSource): Promise<string | null> {
  const path = await resolveProviderPath(src);
  let parents: ParentIdentity[];
  try { parents = await validateProviderParents(path, false); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    st = await fs.lstat(path);
  } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new Error('unsafe Goose provider cache file');
  await assertProviderParentsUnchanged(parents);
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) throw new Error('Goose provider cache identity changed');
    await assertProviderParentsUnchanged(parents);
    const value = await fd.readFile('utf8');
    await assertProviderParentsUnchanged(parents);
    const after = await fs.lstat(path);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || after.dev !== st.dev || after.ino !== st.ino) throw new Error('Goose provider cache identity changed');
    return value;
  } finally { await fd.close(); }
}

export async function readGooseProviderFileForTests(src: FileSource): Promise<string | null> {
  try { return await checkedProviderReadImpl(src); } catch (err) { throw providerPublicError(err); }
}

/** Metadata-only provider-cache inspection for doctor/detector. */
export async function providerFileExistsChecked(src: FileSource): Promise<boolean> {
  try {
  const path = await resolveProviderPath(src);
  let parents: ParentIdentity[];
  try { parents = await validateProviderParents(path, false); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
  let st: Awaited<ReturnType<typeof fs.lstat>>;
  try { st = await fs.lstat(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new Error('unsafe Goose provider cache file');
  await assertProviderParentsUnchanged(parents);
  const fd = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await fd.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== st.dev || opened.ino !== st.ino) throw new Error('Goose provider cache identity changed');
    await assertProviderParentsUnchanged(parents);
    const after = await fs.lstat(path);
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1 || after.dev !== st.dev || after.ino !== st.ino) throw new Error('Goose provider cache identity changed');
    return true;
  } finally { await fd.close(); }
  } catch (err) { throw providerPublicError(err); }
}

type ParentIdentity = { path: string; dev: number; ino: number };
function providerParentIsPrivate(st: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  const uid = process.getuid?.();
  return !st.isSymbolicLink() && st.isDirectory() && (uid === undefined || st.uid === uid) && (Number(st.mode) & 0o022) === 0;
}
async function validateProviderParents(path: string, createMissing: boolean): Promise<ParentIdentity[]> {
  // 기준선도 **해석된** HOME 이어야 한다. `process.env.HOME` 이 미해석이면(macOS 의 `/var` →
  // `/private/var` 처럼) 해석된 대상 경로와 접두가 어긋나 정상 경로가 전부 거부된다.
  const home = await resolvedHome(); const parent = dirname(path);
  if (!home || !parent.startsWith(home + sep)) throw new Error('unsafe Goose provider cache parent');
  const parts = relative(home, parent).split(sep); let current = home; const identities: ParentIdentity[] = [];
  for (const part of ['.', ...parts]) {
    if (part !== '.') current = `${current}${sep}${part}`;
    try {
      const st = await fs.lstat(current);
      if (!providerParentIsPrivate(st)) throw new Error('unsafe Goose provider cache parent'); identities.push({ path: current, dev: Number(st.dev), ino: Number(st.ino) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !createMissing || part === '.') throw err;
      await assertProviderParentsUnchanged(identities);
      await fs.mkdir(current, { mode: 0o700 });
      const st = await fs.lstat(current); if (!providerParentIsPrivate(st)) throw new Error('unsafe Goose provider cache parent'); identities.push({ path: current, dev: Number(st.dev), ino: Number(st.ino) });
    }
  }
  // 해석 안정성: 처음 해석과 walk 완료 시점의 해석이 갈라지면 그 사이에 조상이 바뀐 것이다.
  // 부모 dev/ino pinning 은 **관측한** 조상만 지키므로, 관측 자체가 다른 실물을 향하게 된
  // 경우는 이 재해석 비교로만 잡힌다.
  const again = await resolvePathIdentity(path);
  if (again.kind === 'unresolvable' || again.path !== path) throw new Error('Goose provider cache parent identity changed');
  return identities;
}
async function assertProviderParentsUnchanged(expected: ParentIdentity[]): Promise<void> { for (const item of expected) { const st = await fs.lstat(item.path); if (st.isSymbolicLink() || Number(st.dev) !== item.dev || Number(st.ino) !== item.ino) throw new Error('Goose provider cache parent identity changed'); } }

async function checkedProviderWriteImpl(src: FileSource, value: string): Promise<void> {
  const path = await resolveProviderPath(src);
  const parents = await validateProviderParents(path, true);
  await assertProviderParentsUnchanged(parents);
  const existing = await fs.lstat(path).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
  if (existing && (existing.isSymbolicLink() || !existing.isFile() || existing.nlink !== 1)) throw new Error('unsafe Goose provider cache file');
  const parent = parents.at(-1);
  if (!parent || parent.path !== dirname(path)) throw new Error('Goose provider cache parent identity changed');
  await writePinnedProviderFile(
    parent.path,
    basename(path),
    value,
    parent,
    existing ? { kind: 'present', dev: Number(existing.dev), ino: Number(existing.ino) } : { kind: 'absent' }
  );
  await assertProviderParentsUnchanged(parents);
}

export async function writeGooseProviderFileForTests(src: FileSource, value: string): Promise<void> {
  try { await checkedProviderWriteImpl(src, value); } catch (err) { throw providerPublicError(err); }
}

/** 임의 source 의 현재 라이브 값을 캡처해 문자열로 반환 (저장 가능한 형태). */
export async function readSource(src: Source): Promise<string | null> {
  // Gate 2 — I/O 시점 게이트. **switch 앞**에서 부른다: 분기마다 부르면 새 source 종류나
  // 새 분기가 추가될 때 조용히 빠지고, 빠진 자리는 그대로 우회 경로가 된다.
  assertSourceMayBeAccessed(src);
  switch (src.type) {
    case 'file':
      return isGooseProviderFile(src) ? readGooseProviderFileForTests(src) : readFileOrNull(src.path);
    case 'directory':
      return readDirectorySource(src);
    case 'keychain':
      return readKeychainSerialized(src);
    case 'os-keyring':
      return readOsKeyringSerialized(src);
    case 'env-secret':
      throw unsupportedEnvSecretSource(src, 'read-source');
    case 'win-credential':
      return readWindowsCredentialSourceSerialized(src);
    default:
      return assertNever(src);
  }
}

/** 임의 source 에 저장된 문자열을 라이브 위치로 복원. */
export async function writeSource(src: Source, value: string): Promise<void> {
  // Gate 2 — I/O 시점 게이트. **switch 앞**에서 부른다: 분기마다 부르면 새 source 종류나
  // 새 분기가 추가될 때 조용히 빠지고, 빠진 자리는 그대로 우회 경로가 된다.
  assertSourceMayBeAccessed(src);
  switch (src.type) {
    case 'file':
      return isGooseProviderFile(src) ? writeGooseProviderFileForTests(src, value) : writeFileAtomic(expandTilde(src.path), value);
    case 'directory':
      return writeDirectorySource(src, value);
    case 'keychain':
      return writeKeychainSerialized(src, value);
    case 'os-keyring':
      return writeOsKeyringSerialized(src, value);
    case 'env-secret':
      throw unsupportedEnvSecretSource(src, 'write-source');
    case 'win-credential':
      return writeWindowsCredentialSourceSerialized(src, value);
    default:
      return assertNever(src);
  }
}

/** 임의 source 의 라이브 존재 여부. */
export async function sourceExists(src: Source): Promise<boolean> {
  // Gate 2 — I/O 시점 게이트. **switch 앞**에서 부른다: 분기마다 부르면 새 source 종류나
  // 새 분기가 추가될 때 조용히 빠지고, 빠진 자리는 그대로 우회 경로가 된다.
  assertSourceMayBeAccessed(src);
  switch (src.type) {
    case 'file':
      return isGooseProviderFile(src) ? providerFileExistsChecked(src) : fileExists(src.path);
    case 'directory':
      return directorySourceExists(src);
    case 'keychain':
      assertValidKeychainSource(src);
      return keychainExists(src.service, src.account);
    case 'os-keyring':
      return osKeyringExists(src);
    case 'env-secret':
      throw unsupportedEnvSecretSource(src, 'source-exists');
    case 'win-credential':
      return windowsCredentialSourceExists(src);
    default:
      return assertNever(src);
  }
}

/** Restore rollback to a source that was absent before a failed transaction. */
export async function removeSource(src: Source): Promise<void> {
  // Gate 2 — I/O 시점 게이트. **switch 앞**에서 부른다: 분기마다 부르면 새 source 종류나
  // 새 분기가 추가될 때 조용히 빠지고, 빠진 자리는 그대로 우회 경로가 된다.
  assertSourceMayBeAccessed(src);
  switch (src.type) {
    case 'file': {
      if (isGooseProviderFile(src)) {
        try { await removeGooseProviderFile(src); } catch (err) { throw providerPublicError(err); }
        return;
      }
      // 여기는 provider 캐시가 **아닌** 일반 파일 전용 경로다 — provider 파일은 위에서
      // removeGooseProviderFile 로 조기 return 되므로, 부모 identity pinning 과 nlink 검사는
      // 그쪽에만 존재한다. (0.8.0 에는 `const parents = null` 과 도달 불가한
      // `isGooseProviderFile(src) && …` 항이 남아 있어 이 경로에도 하드닝이 있는 것처럼
      // 읽혔다 — 실제로는 항상 false 인 죽은 코드였다.)
      const path = expandTilde(src.path);
      const st = await fs.lstat(path).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
      if (st == null) return;
      if (st.isSymbolicLink() || !st.isFile()) throw new Error('unsafe source removal');
      const again = await fs.lstat(path);
      if (again.isSymbolicLink() || !again.isFile() || again.dev !== st.dev || again.ino !== st.ino) throw new Error('unsafe source removal');
      await fs.unlink(path);
      return;
    }
    case 'directory': return removeDirectorySource(src);
    default: throw new Error(`cannot rollback absence for ${src.type} source`);
  }
}

async function removeGooseProviderFile(src: FileSource): Promise<void> {
  const path = await resolveProviderPath(src);
  let parents: ParentIdentity[];
  try { parents = await validateProviderParents(path, false); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  await assertProviderParentsUnchanged(parents);
  const st = await fs.lstat(path).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
  if (st == null) return;
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) throw new Error('unsafe Goose provider cache file');
  await assertProviderParentsUnchanged(parents);
  const again = await fs.lstat(path);
  if (again.isSymbolicLink() || !again.isFile() || again.dev !== st.dev || again.ino !== st.ino || again.nlink !== 1) throw new Error('Goose provider cache target identity changed');
  const parent = parents.at(-1);
  if (!parent || parent.path !== dirname(path)) throw new Error('Goose provider cache parent identity changed');
  await removePinnedChild(dirname(path), basename(path), 'file', parent, { dev: Number(again.dev), ino: Number(again.ino) });
  await assertProviderParentsUnchanged(parents);
}
