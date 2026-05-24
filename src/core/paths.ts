/**
 * 데이터 디렉토리 및 경로 헬퍼.
 * 모든 프로필은 ~/.multi-account-tool 아래에 보관된다.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR_NAME = '.multi-account-tool';

/** ~/.multi-account-tool 의 절대 경로 */
export function dataDir(): string {
  return join(homedir(), DATA_DIR_NAME);
}

/** 전역 설정 파일 경로 */
export function configPath(): string {
  return join(dataDir(), 'config.json');
}

/** 모든 프로필 루트 디렉토리 */
export function profilesDir(): string {
  return join(dataDir(), 'profiles');
}

/** 특정 CLI 의 프로필 루트 */
export function cliProfilesDir(cliId: string): string {
  return join(profilesDir(), cliId);
}

/** 특정 CLI/프로필의 디렉토리 */
export function profileDir(cliId: string, profileName: string): string {
  return join(cliProfilesDir(cliId), profileName);
}

/** 프로필 내 임의 파일 */
export function profileFilePath(cliId: string, profileName: string, fileName: string): string {
  return join(profileDir(cliId, profileName), fileName);
}

/** 프로필 메타 파일 경로 */
export function profileMetaPath(cliId: string, profileName: string): string {
  return profileFilePath(cliId, profileName, 'meta.json');
}

/** lockfile 들이 모이는 디렉토리 (`mat exec` 의 cli 별 직렬화용). */
export function locksDir(): string {
  return join(dataDir(), 'locks');
}

/**
 * filesystem 의 path segment 로 안전한 cli id 형식.
 * 첫 글자는 영문, 이후 영문/숫자/`_`/`-` 만, 1~32자.
 * `cliLockPath` 의 defense-in-depth 검증에 사용 (호출자가 `findCliDef` 로 이미 검증해도 한번 더).
 */
const SAFE_CLI_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

/**
 * 특정 CLI 의 lock 디렉토리 경로 (mkdir-lock 패턴).
 * cliId 가 path traversal 가능 형식이면 throw — `locks/` 바깥으로 escape 방지.
 */
export function cliLockPath(cliId: string): string {
  if (!SAFE_CLI_ID_RE.test(cliId)) {
    throw new Error(`cliId 가 path segment 로 사용 불가한 형식입니다: ${cliId}`);
  }
  return join(locksDir(), `${cliId}.lock`);
}

/** 선행 `~/` 를 home 으로 확장. 그 외 경로는 그대로 반환. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
