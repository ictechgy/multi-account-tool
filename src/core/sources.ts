/**
 * Source 추상화: 파일 또는 macOS Keychain 항목을 동일한 인터페이스로 읽고 쓴다.
 *
 * Keychain 항목은 디스크에 JSON ({@link KeychainStored}) 으로 직렬화되어
 * 보관되므로 readSource / writeSource 는 모든 source 종류에 대해 string 만 다룬다.
 *
 * 안전 원칙:
 * - 파일 쓰기는 .tmp → rename 으로 원자적, 권한 0600, O_EXCL + O_NOFOLLOW.
 * - Keychain 쓰기는 기존 값을 메모리에 백업 → 정확한 acct 매칭 delete → add.
 *   add 실패 시 백업으로 자동 롤백 (자격증명 영구 손실 방지).
 * - 외부 명령은 절대경로 `/usr/bin/security` 만, 인자 배열 spawn (셸 미경유).
 * - 에러 메시지는 30자+ base64-like 시퀀스와 JWT 를 redact (토큰 누설 방지).
 */

import { spawn } from 'node:child_process';
import { constants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expandTilde } from './paths.js';
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

/**
 * 에러 메시지에서 자격증명/토큰 후보 문자열을 가린다.
 * JWT 패턴과 30자 이상 base64-like 시퀀스를 [redacted] 로 대체하고 200자로 절단.
 */
function redact(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9+/=._-]{20,}/g, '[redacted-jwt]')
    .replace(/[A-Za-z0-9+/=_-]{30,}/g, '[redacted]')
    .slice(0, 200);
}

function keychainErr(stage: string, r: CmdResult): Error {
  return new Error(`keychain ${stage} 실패 (code=${r.code}): ${redact(r.stderr || r.stdout)}`);
}

/**
 * macOS Keychain 항목의 account (acct) 메타데이터 조회.
 * 항목이 없거나 acct 가 빈 문자열이면 null.
 */
async function keychainGetAccount(service: string): Promise<string | null> {
  const r = await runCommand(SECURITY_BIN, ['find-generic-password', '-s', service]);
  if (r.code !== 0) return null;
  const m = r.stdout.match(/"acct"<blob>="([^"]*)"/);
  const acct = m?.[1];
  return acct && acct.length > 0 ? acct : null;
}

/** macOS Keychain 항목의 평문 값 조회. 없으면 null, 다른 에러는 throw. */
async function keychainGetValue(service: string): Promise<string | null> {
  const r = await runCommand(SECURITY_BIN, ['find-generic-password', '-s', service, '-w']);
  if (r.code === 0) return r.stdout.replace(/\n$/, '');
  if (r.code === KEYCHAIN_NOT_FOUND_CODE || KEYCHAIN_NOT_FOUND_RE.test(r.stderr)) return null;
  throw keychainErr('읽기', r);
}

/**
 * Keychain 항목을 안전하게 쓴다.
 *  1) 기존 값/account 메모리 백업
 *  2) 백업 acct 와 정확히 매칭되는 항목만 삭제 (-a 명시)
 *  3) 새 값 추가. 실패 시 백업으로 롤백
 *
 * `-A` 로 동일 사용자 모든 앱이 접근 가능한 ACL 사용 (Claude 가 토큰을 못 읽는 회귀 방지).
 * argv 노출 trade-off 는 README 의 "보안" 섹션 참고.
 */
async function keychainSet(service: string, account: string, value: string): Promise<void> {
  const backupValue = await keychainGetValue(service);
  const backupAccount = backupValue != null ? await keychainGetAccount(service) : null;

  if (backupValue != null) {
    const delArgs = ['delete-generic-password', '-s', service];
    if (backupAccount) delArgs.push('-a', backupAccount);
    const delRes = await runCommand(SECURITY_BIN, delArgs);
    if (delRes.code !== 0) {
      throw keychainErr('백업 항목 삭제', delRes);
    }
  }

  const addRes = await runCommand(SECURITY_BIN, [
    'add-generic-password',
    '-s', service,
    '-a', account,
    '-w', value,
    '-A'
  ]);

  if (addRes.code !== 0) {
    if (backupValue != null) {
      // best-effort 롤백: 실패하더라도 원본 에러를 사용자에게 전달
      await runCommand(SECURITY_BIN, [
        'add-generic-password',
        '-s', service,
        '-a', backupAccount || account,
        '-w', backupValue,
        '-A'
      ]);
    }
    throw keychainErr('쓰기', addRes);
  }
}

/** Keychain 항목 존재 여부. */
async function keychainExists(service: string): Promise<boolean> {
  const r = await runCommand(SECURITY_BIN, ['find-generic-password', '-s', service]);
  return r.code === 0;
}

/** Keychain source 를 직렬화된 JSON 문자열로 캡처 (저장용). */
async function readKeychainSerialized(src: KeychainSource): Promise<string | null> {
  if (process.platform !== 'darwin') {
    throw new Error('keychain source 는 macOS 에서만 지원됩니다.');
  }
  const value = await keychainGetValue(src.service);
  if (value == null) return null;
  const account = await keychainGetAccount(src.service);
  const stored: KeychainStored = { value, account: account ?? undefined };
  return JSON.stringify(stored);
}

/** 직렬화된 JSON 을 받아 Keychain 항목을 복원. */
async function writeKeychainSerialized(src: KeychainSource, serialized: string): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('keychain source 는 macOS 에서만 지원됩니다.');
  }
  const stored = JSON.parse(serialized) as KeychainStored;
  const account = stored.account || process.env.USER || 'default';
  await keychainSet(src.service, account, stored.value);
}

/**
 * 파일을 원자적으로 쓴다 (.tmp → rename), 권한 0600, 부모 디렉토리 자동 생성.
 *
 * 보안 플래그:
 * - O_EXCL: tmp 가 이미 존재하면 fail (실수/race 방지)
 * - O_NOFOLLOW: tmp 가 symlink 라면 fail (attacker symlink 추적 차단, TOCTOU 완화)
 *
 * 실패 시 tmp 잔존물 정리 (best-effort).
 */
async function writeFileAtomic(path: string, value: string): Promise<void> {
  const abs = expandTilde(path);
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  const FLAGS =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_NOFOLLOW;
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(tmp, FLAGS, 0o600);
    await handle.writeFile(value);
    await handle.close();
    handle = undefined;
    await fs.rename(tmp, abs);
  } catch (err) {
    if (handle) await handle.close().catch(() => { /* best-effort */ });
    await fs.rm(tmp, { force: true }).catch(() => { /* best-effort */ });
    throw err;
  }
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
  if (src.type === 'file') return writeFileAtomic(src.path, value);
  return writeKeychainSerialized(src, value);
}

/** 임의 source 의 라이브 존재 여부. */
export async function sourceExists(src: Source): Promise<boolean> {
  if (src.type === 'file') return fileExists(src.path);
  return keychainExists(src.service);
}
