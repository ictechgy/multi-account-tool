/**
 * 테스트 전용: HOME 을 임시 디렉토리로 override 해서 실제 ~/.multi-account-tool/ 오염 방지.
 *
 * paths.ts 의 `homedir()` 는 macOS/Linux 에서 `$HOME` 을 우선 참조한다.
 * 따라서 process.env.HOME 만 바꾸면 dataDir/locksDir 등이 모두 임시 경로로 이동한다.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface TmpHome {
  /** 임시 HOME 절대경로. 테스트 안에서 paths.* 호출하면 이 아래로 떨어진다. */
  home: string;
  /** afterEach 에서 호출. HOME 복원 + 임시 디렉토리 삭제. */
  cleanup(): Promise<void>;
}

/** 임시 HOME 을 만들고 process.env.HOME 을 그쪽으로 가리킨다. */
export async function setupTmpHome(): Promise<TmpHome> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'mat-test-'));
  process.env.HOME = home;
  return {
    home,
    cleanup: async () => {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(home, { recursive: true, force: true });
    }
  };
}
