/**
 * 전역 설정 (config.json) 의 로드/저장 + 활성 프로필 포인터 관리.
 * 모든 쓰기는 .tmp → rename 으로 원자적이며 파일 권한은 0600.
 */

import { promises as fs } from 'node:fs';
import { configPath, dataDir } from './paths.js';
import type { Config } from './types.js';

const DEFAULT_CONFIG: Config = { version: 1, active: {} };

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
      active: { ...(parsed.active ?? {}) }
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
