/**
 * 전역 설정 (config.json) 의 로드/저장 + 활성 프로필 포인터 관리.
 *
 * 모든 쓰기는 io-atomic 의 writeFileAtomic (O_EXCL + O_NOFOLLOW + 0600) 으로 통일.
 * 모든 mutation 은 mutateConfig 헬퍼를 거쳐 load → mutate → save 가 in-process 직렬화된다.
 * (다중 프로세스 race 는 mat 의 단일 프로세스 TUI 모델 하에서 발생하지 않음.)
 *
 * 부수 기능:
 * - cleanupTmpFiles: 시작 시 데이터 디렉토리의 .tmp 잔존 파일 정리 (symlink 추적 안 함)
 * - markFirstImportPromptShown: 첫 실행 가져오기 프롬프트 표시 기록
 */

import { Dirent, promises as fs } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from './io-atomic.js';
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
      firstImportPromptShown: parsed.firstImportPromptShown,
      firstFreshnessPromptShown: parsed.firstFreshnessPromptShown
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, active: {} };
    }
    throw err;
  }
}

/** config 를 원자적으로 저장 (writeFileAtomic 사용). */
export async function saveConfig(cfg: Config): Promise<void> {
  await ensureDataDir();
  await writeFileAtomic(configPath(), JSON.stringify(cfg, null, 2));
}

/**
 * config 의 load → mutate → save 를 한 호출로 묶는다.
 * 모든 mutator 가 이 헬퍼를 거치므로 mutator 내부에서 cfg 를 직접 변경해도 안전.
 * (in-process 직렬화. 다중 프로세스 동시 실행은 본 도구 사용 시나리오 아님.)
 */
export async function mutateConfig(
  mutator: (cfg: Config) => void | Promise<void>
): Promise<void> {
  const cfg = await loadConfig();
  await mutator(cfg);
  await saveConfig(cfg);
}

/** 특정 CLI 의 활성 프로필 포인터를 설정. */
export async function setActiveProfile(cliId: string, profileName: string): Promise<void> {
  await mutateConfig((cfg) => {
    cfg.active[cliId] = profileName;
  });
}

/** 특정 CLI 의 활성 프로필 이름을 반환 (없으면 undefined). */
export async function getActiveProfile(cliId: string): Promise<string | undefined> {
  const cfg = await loadConfig();
  return cfg.active[cliId];
}

/** 특정 CLI 의 활성 포인터를 제거. */
export async function clearActiveProfile(cliId: string): Promise<void> {
  await mutateConfig((cfg) => {
    delete cfg.active[cliId];
  });
}

/**
 * 첫 실행 가져오기 프롬프트가 표시되었음을 기록.
 * 다음 실행부터 자동 프롬프트가 생략되며, 사용자는 메뉴에서 명시적으로 캡처할 수 있다.
 * 이미 표시된 경우 추가 save 없이 no-op.
 */
export async function markFirstImportPromptShown(): Promise<void> {
  await mutateConfig((cfg) => {
    if (!cfg.firstImportPromptShown) cfg.firstImportPromptShown = true;
  });
}

/**
 * PR-G: TUI 의 freshness dialog 가 첫 표시 시 onboarding 패널을 함께 출력했음을 기록.
 * 이후 표시부터는 dialog 본문만 보여 noise 최소화. dialog 자체는 매번 표시됨.
 * 이미 표시된 경우 추가 save 없이 no-op.
 */
export async function markFirstFreshnessPromptShown(): Promise<void> {
  await mutateConfig((cfg) => {
    if (!cfg.firstFreshnessPromptShown) cfg.firstFreshnessPromptShown = true;
  });
}

/**
 * 데이터 디렉토리 전체에서 `.tmp` 잔존 파일을 정리한다 (앱 시작 시 호출).
 * 이전 실행에서 비정상 종료로 남은 atomic-write 임시 파일을 제거.
 * symlink 는 추적하지 않는다 (loop / out-of-scope 디렉토리 보호).
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
    // symlink 는 따라가지 않는다 (loop 방지 + scope 보호).
    if (e.isSymbolicLink()) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      await walkAndCleanTmp(full);
    } else if (e.isFile() && e.name.endsWith('.tmp')) {
      await fs.rm(full, { force: true }).catch(() => { /* best-effort */ });
    }
  }
}
