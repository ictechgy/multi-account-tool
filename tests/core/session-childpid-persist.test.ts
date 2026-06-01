/**
 * PR #71 결함1: 자식 pid 의 2단계 persist — childPid 가 ps(서명 조회) 호출 **전에** session.json
 * 에 기록되는지 검증한다.
 *
 * 결함: 기존 recordChildPid 는 `meta.childPid` 설정 → `await processStartSignature`(ps exec, 최대 2s)
 * → writeSessionMeta 순서라, ps 가 진행되는 동안 session.json 에 childPid 가 없었다. 그 윈도우에
 * 소유 mat 이 죽고 subshell 이 장기 생존하면 reapOrphans 가 childPid 부재 메타를 옛 메타로 오인해
 * 라이브 세션을 삭제할 수 있다.
 *
 * 수정: 1단계 — childPid 만 먼저 기록(ps 전), 2단계 — 서명을 구해 childPidStart 후속 기록.
 *
 * Mock 전략: `node:child_process` 의 `execFile`(processStartSignature 가 사용) 을 **지연 콜백**으로
 * 만들어, 서명 조회가 아직 pending 인 동안 session.json 을 읽어 childPid 가 이미 디스크에 있고
 * childPidStart 는 아직 없음을 단언한다 → 1단계가 ps 전에 완결됐음을 증명한다.
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDef } from '../../src/core/types.js';

const CHILD_PID = 424242; // 임의의 자식 pid — session.json 에 기록되는지 확인용

// 자식 pid(CHILD_PID) 의 서명 조회만 지연시킨다(콜백 보관). 부모 pid 등 그 외는 즉시 resolve 해
// runSession 이 spawn 까지 진행하게 한다 — 모든 ps 를 막으면 부모 pidStart 조회에서 멈춘다.
let pendingChildPsCallbacks: Array<(err: Error | null, stdout: string) => void> = [];
function flushChildPs(stdout: string): void {
  const cbs = pendingChildPsCallbacks;
  pendingChildPsCallbacks = [];
  for (const cb of cbs) cb(null, stdout);
}

// 제어 가능한 spawn child — pid 를 지정하고 exit 를 수동으로 emit 한다.
let spawnedChild: (EventEmitter & { pid: number; exitCode: number | null; signalCode: NodeJS.Signals | null; kill: ReturnType<typeof vi.fn> }) | null = null;

vi.mock('node:child_process', () => ({
  spawn: vi.fn(() => spawnedChild as unknown as ChildProcess),
  // processStartSignature 가 `ps -o lstart= -p <pid>` 로 호출 — args 의 마지막이 pid 문자열.
  // 자식 pid(CHILD_PID) 서명 조회만 pending 으로 보류(2단계 보류), 부모 등은 즉시 resolve.
  execFile: vi.fn(
    (_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      const isChild = args[args.length - 1] === String(CHILD_PID);
      if (isChild) {
        pendingChildPsCallbacks.push(cb); // 자식 서명 조회는 pending 으로 보관(테스트가 풀어줌)
      } else {
        cb(null, 'Mon Jan  1 00:00:00 2000\n'); // 부모 등은 즉시 resolve
      }
    }
  )
}));

vi.mock('../../src/core/cli-defs.js', () => ({ findCliDef: vi.fn() }));
vi.mock('../../src/core/profile-store.js', () => ({
  validateProfileName: vi.fn((n: string) => n),
  profileExists: vi.fn().mockResolvedValue(true),
  readProfileFile: vi.fn().mockResolvedValue('TOK'),
  writeProfileFile: vi.fn().mockResolvedValue(undefined),
  stageProfileFile: vi.fn().mockResolvedValue('/stub/staged'),
  commitStagedFile: vi.fn().mockResolvedValue(undefined),
  discardStagedFile: vi.fn().mockResolvedValue(undefined),
  removeProfileFile: vi.fn().mockResolvedValue(undefined)
}));

import { findCliDef } from '../../src/core/cli-defs.js';
import { sessionsDir } from '../../src/core/paths.js';
import { runSession } from '../../src/core/session.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const DEF = {
  id: 'codex',
  name: 'Codex (fixture)',
  sources: [{ type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }],
  session: { roots: [{ env: 'CODEX_HOME', base: '~/.codex' }] }
} satisfies CliDef;

function makeControllableChild(): typeof spawnedChild {
  const ee = new EventEmitter() as NonNullable<typeof spawnedChild>;
  ee.pid = CHILD_PID;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn();
  return ee;
}

/** sessionsDir 안의 유일한 세션 디렉토리에서 session.json 을 읽어 파싱(없으면 null). */
async function readOnlySessionMeta(): Promise<Record<string, unknown> | null> {
  const ids = await fs.readdir(sessionsDir()).catch(() => [] as string[]);
  if (ids.length !== 1) return null;
  const raw = await fs.readFile(join(sessionsDir(), ids[0], 'session.json'), 'utf8').catch(() => null);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
}

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await setupTmpHome();
  pendingChildPsCallbacks = [];
  spawnedChild = makeControllableChild();
  vi.mocked(findCliDef).mockReturnValue(DEF);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

describe('recordChildPid — 2단계 persist (childPid 가 ps 전에 기록, #71 결함1)', () => {
  it('서명 조회(ps) pending 중에도 session.json 에 childPid 가 이미 기록돼 있다', async () => {
    const child = spawnedChild!;
    // runSession 을 await 하지 않고 시작 — spawn → recordChildPid 1단계(childPid only) 가 돌게 한다.
    const runPromise = runSession({ cliId: 'codex', profileName: 'work' });

    // recordChildPid 는 fire-and-forget(void onSpawned)이라 여러 await(stage1 write → import →
    // execFile)를 거친다. 1단계 write 가 session.json 에 childPid 를 기록할 때까지 task 를 흘린다.
    // 2단계(childPidStart)는 자식 서명 조회(ps)가 pending 으로 보류되므로 이 동안 완료될 수 없다 —
    // 따라서 "childPid 있음 + childPidStart 없음" 을 안정적으로 관측할 수 있는 봉인 윈도우가 생긴다.
    let metaDuringPs: Record<string, unknown> | null = null;
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      metaDuringPs = await readOnlySessionMeta();
      if (metaDuringPs && metaDuringPs.childPid != null) break;
    }

    // 핵심 단언: 자식 서명 조회(ps)가 보류 중인데 session.json 에 childPid 가 이미 있다(1단계 완결).
    expect(metaDuringPs).not.toBeNull();
    expect(metaDuringPs!.childPid).toBe(CHILD_PID);
    // 자식 서명 조회(ps)는 보류 상태여야 한다 — 2단계가 아직 진행 못 함을 보장(타이밍 봉인).
    expect(pendingChildPsCallbacks.length).toBeGreaterThanOrEqual(1);
    // 2단계(childPidStart)는 아직 — ps 가 pending 이므로 미기록(half-update 가 아닌 완결 상태).
    expect(metaDuringPs!.childPidStart).toBeUndefined();

    // 정리: 자식 ps 콜백을 풀고(2단계 완료) 자식 종료를 emit 해 runSession 을 정상 종료시킨다.
    flushChildPs('Mon Jan  1 00:00:00 2000\n');
    child.emit('exit', 0, null);
    await runPromise;
    // 세션은 종료 후 정리됨(디렉토리 삭제) — 회귀 0 확인.
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });
});
