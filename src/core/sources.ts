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
import { redactMessage } from './errors.js';
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
 *  2) 백업 acct 와 정확히 매칭되는 항목만 삭제 (-a 명시).
 *     백업이 있는데 acct 를 모를 때는 console.warn 만 출력하고 service-only 삭제 (옛 동작 유지).
 *  3) 새 값 추가. 실패 시 백업으로 롤백 (롤백 결과도 확인해 실패 시 에러에 첨부).
 *
 * `-A` 로 동일 사용자 모든 앱이 접근 가능한 ACL 사용 (Claude 가 토큰을 못 읽는 회귀 방지).
 * argv 노출 trade-off 는 README 의 "보안" 섹션 참고.
 */
async function keychainSet(service: string, account: string, value: string): Promise<void> {
  const backupValue = await keychainGetValue(service);
  const backupAccount = backupValue != null ? await keychainGetAccount(service) : null;

  if (backupValue != null) {
    const delArgs = ['delete-generic-password', '-s', service];
    if (backupAccount) {
      delArgs.push('-a', backupAccount);
    } else {
      console.warn(`경고: keychain service '${service}' 의 account 를 파악할 수 없어 service-only 삭제를 수행합니다. 동일 service 의 다른 항목이 영향받을 수 있습니다.`);
    }
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
    let rollbackNote = '';
    if (backupValue != null) {
      const rb = await runCommand(SECURITY_BIN, [
        'add-generic-password',
        '-s', service,
        '-a', backupAccount || account,
        '-w', backupValue,
        '-A'
      ]);
      if (rb.code !== 0) {
        rollbackNote = ` / 백업 복구도 실패 (code=${rb.code}): ${redactMessage(rb.stderr)}`;
      }
    }
    throw new Error(`keychain 쓰기 실패 (code=${addRes.code}): ${redactMessage(addRes.stderr || addRes.stdout)}${rollbackNote}`);
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
  return keychainExists(src.service);
}
