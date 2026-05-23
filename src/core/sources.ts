/**
 * Source 추상화: 파일 또는 macOS Keychain 항목을 동일한 인터페이스로 읽고 쓴다.
 *
 * Keychain 항목은 디스크에 JSON ({@link KeychainStored}) 으로 직렬화되어
 * 보관되므로 readSource / writeSource 는 모든 source 종류에 대해 string 만 다룬다.
 *
 * 안전 원칙:
 * - 파일 쓰기는 .tmp → rename 으로 원자적, 권한 0600.
 * - Keychain 쓰기는 동일 service 의 기존 항목을 먼저 삭제 후 추가 (`-A` 로 모든 앱 접근 허용).
 * - 외부 명령은 spawn 으로 인자 배열 전달 (셸 주입 방지).
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { expandTilde } from './paths.js';
import type { KeychainSource, KeychainStored, Source } from './types.js';

interface CmdResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 외부 명령을 spawn 으로 안전하게 실행. */
function runCommand(cmd: string, args: string[]): Promise<CmdResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
    proc.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** macOS Keychain 항목의 account (acct) 메타데이터를 조회. 없으면 null. */
async function keychainGetAccount(service: string): Promise<string | null> {
  const r = await runCommand('security', ['find-generic-password', '-s', service]);
  if (r.code !== 0) return null;
  const m = r.stdout.match(/"acct"<blob>="([^"]*)"/);
  return m ? m[1] : null;
}

/** macOS Keychain 항목의 평문 값을 조회. 없으면 null. */
async function keychainGetValue(service: string): Promise<string | null> {
  const r = await runCommand('security', ['find-generic-password', '-s', service, '-w']);
  if (r.code === 0) return r.stdout.replace(/\n$/, '');
  if (/could not be found/i.test(r.stderr)) return null;
  if (r.code === 44) return null;
  throw new Error(`keychain 읽기 실패 (code=${r.code}): ${r.stderr || r.stdout}`);
}

/**
 * Keychain 항목을 새로 쓴다 (기존 동일 service 는 삭제 후 추가).
 * `-A` 플래그로 동일 사용자의 모든 앱이 접근 가능하도록 ACL 을 설정한다.
 */
async function keychainSet(service: string, account: string, value: string): Promise<void> {
  await runCommand('security', ['delete-generic-password', '-s', service]);
  const r = await runCommand('security', [
    'add-generic-password',
    '-s', service,
    '-a', account,
    '-w', value,
    '-A'
  ]);
  if (r.code !== 0) {
    throw new Error(`keychain 쓰기 실패 (code=${r.code}): ${r.stderr || r.stdout}`);
  }
}

/** Keychain 항목 존재 여부. */
async function keychainExists(service: string): Promise<boolean> {
  const r = await runCommand('security', ['find-generic-password', '-s', service]);
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

/** 파일을 원자적으로 쓴다 (.tmp → rename), 권한 0600, 부모 디렉토리 자동 생성. */
async function writeFileAtomic(path: string, value: string): Promise<void> {
  const abs = expandTilde(path);
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, value, { mode: 0o600 });
  await fs.rename(tmp, abs);
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
