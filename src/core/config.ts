/**
 * 전역 설정 (config.json) 의 로드/저장 + 활성 프로필 포인터 관리.
 * 모든 쓰기는 .tmp → rename 으로 원자적이며 파일 권한은 0600.
 *
 * 부수 기능:
 * - cleanupTmpFiles: 시작 시 데이터 디렉토리의 .tmp 잔존 파일 정리
 * - markFirstImportPromptShown: 첫 실행 가져오기 프롬프트 표시 기록
 */

import { Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { configPath, dataDir } from './paths.js';
import type { Config } from './types.js';

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true, mode: 0o700 });
}

/** config.json 을 읽어 반환. 없으면 기본값을 반환. */
export async function loadConfig(): Promise<Config> {
  try {
    const raw = await fs.readFile(configPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<Config>;
    return {
      version: 1,
      active: { ...(parsed.active ?? {}) },
      firstImportPromptShown: parsed.firstImportPromptShown
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, active: {} };
    }
    throw err;
  }
}

/** config 를 원자적으로 저장. */
export async function saveConfig(cfg: Config): Promise<void> {
  await ensureDataDir();
  const tmp = `${configPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  await fs.rename(tmp, configPath());
}

/** 특정 CLI 의 활성 프로필 포인터를 설정. */
export async function setActiveProfile(cliId: string, profileName: string): Promise<void> {
  const cfg = await loadConfig();
  cfg.active[cliId] = profileName;
  await saveConfig(cfg);
}

/** 특정 CLI 의 활성 프로필 이름을 반환 (없으면 undefined). */
export async function getActiveProfile(cliId: string): Promise<string | undefined> {
  const cfg = await loadConfig();
  return cfg.active[cliId];
}

/** 특정 CLI 의 활성 포인터를 제거. */
export async function clearActiveProfile(cliId: string): Promise<void> {
  const cfg = await loadConfig();
  delete cfg.active[cliId];
  await saveConfig(cfg);
}

/**
 * 첫 실행 가져오기 프롬프트가 표시되었음을 기록.
 * 다음 실행부터 자동 프롬프트가 생략되며, 사용자는 메뉴에서 명시적으로 캡처할 수 있다.
 */
export async function markFirstImportPromptShown(): Promise<void> {
  const cfg = await loadConfig();
  if (cfg.firstImportPromptShown) return;
  cfg.firstImportPromptShown = true;
  await saveConfig(cfg);
}

/**
 * 데이터 디렉토리 전체에서 `.tmp` 잔존 파일을 정리한다 (앱 시작 시 호출).
 * 이전 실행에서 비정상 종료로 남은 atomic-write 임시 파일을 제거.
 * 실패는 무시 (best-effort).
 */
export async function cleanupTmpFiles(): Promise<void> {
  await walkAndCleanTmp(dataDir()).catch(() => { /* best-effort */ });
}

async function walkAndCleanTmp(dir: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkAndCleanTmp(full);
    } else if (e.isFile() && e.name.endsWith('.tmp')) {
      await fs.rm(full, { force: true }).catch(() => { /* best-effort */ });
    }
  }
}
