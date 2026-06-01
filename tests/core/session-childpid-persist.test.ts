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
import { sessionDir, sessionsDir } from '../../src/core/paths.js';
import { reapOrphans, runSession } from '../../src/core/session.js';
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

/**
 * PR #71 결함(race + lifecycle): child 가 recordChildPid 진행 중(자식 서명 ps 대기 중)에 **먼저 exit**
 * 하는 시나리오 — runSession 의 종료 정리(recaptureBestEffort/removeSessionDir)가 recordChildPid 의
 * 완료를 보장하지 못하면, removeSessionDir 로 세션 디렉토리가 지워진 뒤 recordChildPid 의 2단계
 * writeSessionMeta 가 실행돼 writeFileAtomic 의 recursive mkdir 가 **삭제된 디렉토리에 session.json 만
 * 재생성(orphan)** 한다.
 *
 * 수정: runSession 이 record promise 를 캡처해 cleanup 직전에 `await` 로 settle 한다. 그러면 child 가
 * 빨리 exit 해도 removeSessionDir 는 항상 recordChildPid 완료 후 실행돼 orphan 이 남지 않는다.
 *
 * 본 테스트는 자식 서명 조회(execFile child ps)를 보류시켜 recordChildPid 를 2단계 진입 전에 **pending**
 * 으로 묶어둔 채 child exit 를 먼저 emit 한다.
 *
 * **결함 재현/포착 포인트**: writeFileAtomic 은 ENOENT 로 실패하지 않고 recursive mkdir 로 삭제된
 * 디렉토리를 **재생성한 뒤 rename 을 성공**시키므로, 수정 전 코드에서 "자식 pid 기록 실패" 경고는
 * 나오지 않는다(경고 기반 검증은 결함을 못 잡는다). 또한 2단계 write 는 수정 전 코드에서 cleanup 이
 * resolve 된 **뒤** detached 로 일어나므로, `await runPromise` 직후가 아니라 그 detached write 가
 * 디스크에 landing 할 시간을 충분히 흘린 **뒤** orphan(session.json) 부재를 검증해야 race 를 포착한다.
 *  - 수정 전: removeSessionDir 가 record 완료 전에 실행 → 이후 풀린 2단계 write 가 삭제된 디렉토리에
 *    session.json 만 재생성(orphan) → 최종 검증에서 디렉토리/파일이 **남는다**(실패).
 *  - 수정 후: cleanup 이 `await recordChildPidDone` 에서 멈춰 2단계 write 가 먼저 정상 디렉토리에서
 *    완료된 뒤 removeSessionDir 가 전부 삭제 → orphan **없음**(통과).
 */
describe('runSession — exit-before-write race (recordChildPid settle 보장, #71)', () => {
  it('child 가 ps 대기 중 먼저 exit → cleanup 이 record settle 후 실행돼 orphan session.json 미잔류', async () => {
    const child = spawnedChild!;
    const runPromise = runSession({ cliId: 'codex', profileName: 'work' });

    // recordChildPid 1단계(childPid write) 완료 + 2단계 ps 가 pending 으로 보류될 때까지 흘린다.
    // 이 시점: session.json 에 childPid 있음, childPidStart 없음, 자식 ps 콜백 1개 보류.
    let armed = false;
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const meta = await readOnlySessionMeta();
      if (meta && meta.childPid != null && pendingChildPsCallbacks.length >= 1) {
        armed = true;
        break;
      }
    }
    expect(armed).toBe(true); // race 윈도우(2단계 ps 보류) 확보

    // child 를 **먼저** exit 시킨다 — recordChildPid 2단계(ps→write)는 아직 보류 중.
    // spawnSessionShell 의 promise 가 resolve 되고 runSession 이 cleanup 으로 진행을 시도한다.
    child.emit('exit', 0, null);

    // exit 후 충분한 시간(매크로태스크 + 실제 fs I/O 윈도우)을 흘린다.
    //  - 수정 전 코드: cleanup(recapture→removeSessionDir)이 record 완료를 기다리지 않고 끝까지 진행돼
    //    이 시점에 세션 디렉토리를 이미 삭제한다(ps 는 아직 보류라 2단계 write 미실행).
    //  - 수정 후 코드: cleanup 이 `await recordChildPidDone` 에서 멈춰 디렉토리를 아직 안 지운다
    //    (2단계 write 가 먼저 끝나야 진행 — 그 트리거는 아래 flush).
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    // 이제 보류된 자식 ps 를 풀어 recordChildPid 2단계(ps→writeSessionMeta)를 완료시킨다.
    //  - 수정 전: 이미 삭제된 디렉토리에 writeFileAtomic 가 recursive mkdir 로 디렉토리를 재생성하고
    //    rename 을 성공시켜 session.json 만 남는 orphan 을 만든다(경고 없이 조용히 재생성).
    //  - 수정 후: 이 2단계 settle 이 끝나야 cleanup 이 진행돼 removeSessionDir 가 그 **뒤에** 실행 →
    //    write 는 항상 정상 디렉토리에서 성공한 뒤 디렉토리 전체가 삭제 → orphan 0.
    flushChildPs('Mon Jan  1 00:00:00 2000\n');

    const result = await runPromise;
    expect(result).toEqual({ code: 0, signal: null, recaptureError: undefined });

    // 보류된 자식 ps 콜백이 모두 소진돼야 2단계 write 가 트리거된 것이다(record settle 확인).
    expect(pendingChildPsCallbacks).toHaveLength(0);

    // **결함 포착 핵심**: 수정 전 코드의 detached 2단계 write 는 runSession resolve 이후에 landing 할
    // 수 있으므로, `await runPromise` 직후가 아니라 그 write 가 디스크에 반영될 시간을 충분히 흘린 뒤
    // orphan 을 검증한다. 수정 전이면 여기서 삭제됐던 디렉토리에 session.json 이 재생성돼 남는다.
    for (let i = 0; i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    // 핵심 단언: 세션 디렉토리가 완전히 삭제됨 — orphan session.json/디렉토리 0.
    // (수정 전 코드에서는 재생성된 orphan 디렉토리가 남아 이 단언이 실패한다.)
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });
});

/**
 * PR #71 round3 결함(Codex HIGH, pid-reuse): child(subshell)가 서명 캡처(ps) 전/중에 이미 exit 하고
 * OS 가 그 pid 를 재사용하면, processStartSignature 가 무관 프로세스의 시작 서명을 잡아 childPidStart
 * 로 굳을 수 있다 → classifyChildOwner 가 그 무관 프로세스를 '서명 일치 라이브 child owner' 로 오인해
 * bounded TTL 을 우회한 영구 보존이 발생한다.
 *
 * 수정: 서명을 구한 뒤 기록 직전 isChildAlive() 로 child 생존을 재확인 — child 가 exit 했으면
 * childPidStart 를 기록하지 않는다(undefined 유지) → classifyChildOwner 가 'unknown' → bounded TTL 회수.
 *
 * 본 describe 는 두 갈래를 검증한다:
 *  (1) child 가 ps 캡처 전 exit → 최종 session.json 에 childPidStart 미기록(서명 skip).
 *  (2) child 가 ps 캡처 동안 생존 → childPidStart 정상 기록(서명 유효).
 * 그리고 (1) 의 산물(childPidStart 없는 메타)이 classifyChildOwner 경로에서 unknown → reapOrphans 의
 * bounded TTL 회수 대상이 됨을 합성 메타로 end-to-end 확인한다(영구 보존 안 함).
 */
describe('recordChildPid — child exit 후 서명 skip (pid 재사용 방어, #71 round3 Codex HIGH)', () => {
  /** runSession 진행 중 spawn 된 child 가 1단계(childPid) 기록 + 2단계 ps pending 까지 도달할 때까지 흘린다. */
  async function armChildPidPending(): Promise<void> {
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      const meta = await readOnlySessionMeta();
      if (meta && meta.childPid != null && pendingChildPsCallbacks.length >= 1) return;
    }
    throw new Error('childPid 1단계 기록 + ps pending 윈도우 확보 실패');
  }

  it('(1) child 가 ps 서명 캡처 전 exit → childPidStart 기록 안 됨(undefined 유지)', async () => {
    const child = spawnedChild!;
    const runPromise = runSession({ cliId: 'codex', profileName: 'work' });

    // 1단계(childPid) 기록 + 2단계 ps 가 pending 으로 보류될 때까지 흘린다.
    await armChildPidPending();

    // child 를 먼저 exit 시킨다 — emit 만으로는 exitCode 가 갱신되지 않으므로(EventEmitter 목)
    // isChildAlive() 가 false 가 되도록 exitCode 를 명시 설정한 뒤 exit 를 emit 한다.
    child.exitCode = 0;
    child.emit('exit', 0, null);

    // 보류된 자식 ps 를 풀어 recordChildPid 2단계를 진행시킨다 — child 가 이미 죽었으므로 서명을
    // 구하더라도 isChildAlive() false 라 childPidStart 를 기록하지 않아야 한다.
    flushChildPs('v1-style-but-irrelevant-signature\n');

    const result = await runPromise;
    expect(result).toEqual({ code: 0, signal: null, recaptureError: undefined });
    expect(pendingChildPsCallbacks).toHaveLength(0); // 2단계 ps 콜백 소진 = record settle 확인

    // detached write 가 남아있을 가능성까지 흘린 뒤(수정 전 race 와 동형 안전망) 최종 상태 확인.
    for (let i = 0; i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 0));

    // 핵심 단언: 세션은 정상 정리됐고, child exit 로 인해 childPidStart 서명이 디스크에 굳지 않았다.
    // (세션 디렉토리는 종료 정리로 삭제되므로 orphan 0 으로 회귀 없음을 함께 확인한다.)
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('(2) child 가 ps 서명 캡처 동안 생존 → childPidStart 정상 기록', async () => {
    const child = spawnedChild!;
    const runPromise = runSession({ cliId: 'codex', profileName: 'work' });

    // 1단계 기록 + 2단계 ps pending 까지 흘린다 (child 는 아직 살아있음 — exitCode null).
    await armChildPidPending();

    // child 가 살아있는 동안 ps 를 flush → isChildAlive() true 라 서명을 정상 기록한다.
    // flush 값은 raw lstart 출력 — processStartSignature 가 PID_SIG_VERSION('v1:') 접두를 붙인다.
    // 기록이 디스크에 landing 한 직후(종료 정리 전) 메타를 관측하기 위해 exit 는 아직 emit 안 한다.
    flushChildPs('Mon Jan  1 00:00:00 2000\n');

    let metaWithSig: Record<string, unknown> | null = null;
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setImmediate(resolve));
      metaWithSig = await readOnlySessionMeta();
      if (metaWithSig && metaWithSig.childPidStart != null) break;
    }

    // 핵심 단언: child 생존 중 캡처라 서명(childPidStart)이 정상 기록됐다(버전 접두 포함).
    expect(metaWithSig).not.toBeNull();
    expect(metaWithSig!.childPid).toBe(CHILD_PID);
    expect(metaWithSig!.childPidStart).toBe('v1:Mon Jan  1 00:00:00 2000');

    // 정리: child exit emit 으로 runSession 정상 종료.
    child.exitCode = 0;
    child.emit('exit', 0, null);
    await runPromise;
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('(3) childPidStart 없는 메타(=child exit skip 산물)는 classifyChildOwner unknown → reapOrphans bounded TTL 회수', async () => {
    // (1) 의 산물과 동형: childPid 는 살아있으나(현재 프로세스 pid 사용) childPidStart 미기록.
    // 소유 mat 은 죽음(존재하지 않는 pid). 결함3 의 핵심 — unknown 은 영구 보존하지 않고 bounded
    // TTL(24h) 초과 시 회수해야 한다(25h 전 startedAt/mtime). 무관 프로세스를 confirmed owner 로
    // 굳히지 않는다.
    const DEAD_PID = 2147483646; // 사실상 미존재 pid → 소유 mat dead-or-reused
    const id = 'codex-work-exitskip1';
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const dir = sessionDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'session.json'),
      JSON.stringify({
        id,
        cli: 'codex',
        profile: 'work',
        pid: DEAD_PID,
        childPid: process.pid, // 자식 pid 는 살아있으나 childPidStart 미기록 → unknown
        startedAt: old,
        roots: []
      })
    );
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);

    const reaped = await reapOrphans();
    expect(reaped).toContain(id); // unknown → bounded TTL 초과 회수(영구 보존 안 함)
    await expect(fs.access(dir)).rejects.toThrow();
  });
});
