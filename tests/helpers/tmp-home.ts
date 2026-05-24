/**
 * 테스트 전용: HOME 을 임시 디렉토리로 override 해서 실제 ~/.multi-account-tool/ 오염 방지.
 *
 * paths.ts 의 `homedir()` 는 macOS/Linux 에서 `$HOME` 을 우선 참조한다.
 * 따라서 process.env.HOME 만 바꾸면 dataDir/locksDir 등이 모두 임시 경로로 이동한다.
 *
 * 동시성 주의: process.env 는 프로세스 전역이라, vitest 의 worker pool 이
 * `threads` 라면 같은 process 내 여러 worker 가 HOME 을 race 로 덮어쓴다.
 * 본 프로젝트의 vitest.config.ts 는 `pool: 'forks'` 를 명시해 각 테스트 파일을
 * 별도 자식 프로세스로 실행함으로써 이 문제를 회피한다. 같은 파일 안에서
 * `test.concurrent` 를 쓸 때는 race 가 다시 발생할 수 있으므로 사용 금지.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** setupTmpHome 의 반환 — 임시 HOME 절대경로와 cleanup 핸들. */
export interface TmpHome {
  /** 임시 HOME 절대경로. 테스트 안에서 paths.* 호출하면 이 아래로 떨어진다. */
  home: string;
  /**
   * afterEach 에서 호출. 두 가지 작업 — process.env.HOME 복원 + tmp 디렉토리 삭제.
   * env 복원을 sync 로 먼저 끝낸 뒤 rm 을 시도하며, rm 실패는 warn 만 하고 throw 하지 않는다
   * (tmp 잔존물은 후속 테스트에 영향을 주지 않으므로 best-effort).
   */
  cleanup(): Promise<void>;
}

/**
 * 임시 HOME 디렉토리를 만들고 process.env.HOME 을 그쪽으로 가리킨다.
 * 반환된 cleanup 을 afterEach 에서 반드시 호출해 env 복원 + tmp 삭제를 보장한다.
 */
export async function setupTmpHome(): Promise<TmpHome> {
  const originalHome = process.env.HOME;
  const home = await mkdtemp(join(tmpdir(), 'mat-test-'));
  process.env.HOME = home;
  return {
    home,
    cleanup: async () => {
      // env 복원이 핵심 보장 — rm 실패와 무관하게 먼저 끝낸다.
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      await rm(home, { recursive: true, force: true }).catch((err) => {
        // tmp 디렉토리 삭제 실패는 다음 테스트의 본질에 영향 없음. 빈 catch 금지 규칙에 따라 warn.
        process.stderr.write(`[setupTmpHome] tmp cleanup 실패: ${(err as Error).message}\n`);
      });
    }
  };
}
