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

/** 선행 `~/` 를 home 으로 확장. 그 외 경로는 그대로 반환. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
