/**
 * runExec 단위 테스트.
 *
 * Mock 전략:
 *  - cli-defs / config / profile-store / switcher / node:child_process: 전부 mock
 *  - lockfile: **partial mock** — 진짜 `LockHeldError` 는 그대로 export 하고
 *    legacy `acquireCliLock` 를 vi.fn() 으로 교체. cli-mutation-lock mock 이 이 spy 를
 *    호출해 release/order 검증과 실제 LockHeldError contract 검증을 유지한다.
 *
 * 시나리오 (Quad-review 합의 후 보강):
 *  - 기본: success / already-active / child non-zero / child signal /
 *          spawn error / missing active / unknown cli / empty cmd /
 *          profile not found / LockHeldError 전파 / release ordering
 *  - 추가 (Forge-2 HIGH 지적): swap 단계 switchProfile 실패 (lock 회수 보장),
 *          child non-zero + restore 실패 매트릭스, spawn error + restore 실패 매트릭스,
 *          SIGINT forwarder 가 child.kill 을 호출하는지
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDef } from '../../src/core/types.js';

vi.mock('../../src/core/cli-defs.js', () => ({
  findCliDef: vi.fn()
}));
vi.mock('../../src/core/config.js', () => ({
  getActiveProfile: vi.fn()
}));
vi.mock('../../src/core/profile-store.js', () => ({
  validateProfileName: vi.fn((n: string) => n),
  profileExists: vi.fn()
}));
vi.mock('../../src/core/switcher.js', () => ({
  switchProfile: vi.fn(),
  // PR-I*: runExec 의 종료 시점 재캡처가 snapshotLiveToProfile 를 직접 호출하므로 mock 필요.
  snapshotLiveToProfile: vi.fn()
}));
const { mockWithCliMutationLock } = vi.hoisted(() => ({
  mockWithCliMutationLock: vi.fn()
}));
// Partial mock: 진짜 LockHeldError 를 보존하고 acquireCliLock 만 spy.
// 가짜 LockHeldError 를 재정의하면 `instanceof` 검증이 mock 클래스에 대해서만 동작하는
// false-positive 가 발생 (Quad-review Finding A).
vi.mock('../../src/core/lockfile.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/lockfile.js')>(
    '../../src/core/lockfile.js'
  );
  return { ...actual, acquireCliLock: vi.fn() };
});
vi.mock('../../src/core/cli-mutation-lock.js', () => ({
  withCliMutationLock: mockWithCliMutationLock
}));
vi.mock('node:child_process', () => ({
  spawn: vi.fn()
}));

import { spawn } from 'node:child_process';

import { findCliDef } from '../../src/core/cli-defs.js';
import { getActiveProfile } from '../../src/core/config.js';
import { UsageError } from '../../src/core/errors.js';
import { runExec } from '../../src/core/exec.js';
import { LockHeldError, acquireCliLock } from '../../src/core/lockfile.js';
import { profileExists } from '../../src/core/profile-store.js';
import {
  snapshotLiveToProfile,
  switchProfile,
  type SnapshotResult,
  type SwitchResult
} from '../../src/core/switcher.js';

const mockFindCliDef = vi.mocked(findCliDef);
const mockGetActive = vi.mocked(getActiveProfile);
const mockProfileExists = vi.mocked(profileExists);
const mockSwitch = vi.mocked(switchProfile);
const mockSnapshot = vi.mocked(snapshotLiveToProfile);
const mockAcquire = vi.mocked(acquireCliLock);
const mockSpawn = vi.mocked(spawn);

/**
 * switchProfile 의 반환 타입을 type alias 로 묶어 mock 캐스팅을 단순화.
 * SwitchResult 시그니처가 바뀌면 이 alias 의 import 자체가 깨져 회귀 감지 가능
 * (`undefined as unknown as ReturnType<typeof switchProfile> extends ...` 패턴은 가림).
 */
type FakeSwitch = SwitchResult;
const FAKE_SWITCH = undefined as unknown as FakeSwitch;

/** snapshotLiveToProfile 의 fake 반환 — runExec 가 결과를 직접 참조하지 않으므로 빈 값. */
const FAKE_SNAPSHOT: SnapshotResult = {
  cliId: 'codex', profileName: '', captured: [], empty: []
};

/**
 * findCliDef fixture — CliDef contract 의 모든 필드 채움 + `satisfies` 로 type-check.
 * CliDef 에 필수 필드가 추가되면 컴파일 단계에서 즉시 감지.
 * runExec 가 실제로는 .id 만 읽지만, contract drift 차단 목적.
 * sources: [] 는 의도적 — runExec 가 sources 를 직접 참조하지 않으므로 빈 배열로 충분
 * (source-level 검증은 switcher/sources 모듈의 별도 테스트에서 다룬다).
 */
const FAKE_CLI_DEF = {
  id: 'codex',
  name: 'Codex (fixture)',
  sources: []
} satisfies CliDef;

/** runExec 가 사용하는 ChildProcess 필드만 흉내내는 fake. 다른 필드는 의도적으로 없음. */
type FakeChildProcess = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

/**
 * `mockSpawn.mockReturnValue` / `mockImplementation` 에 넘길 ChildProcess 캐스팅을
 * 한 곳에 격리. 각 callsite 에 `as unknown as ChildProcess` / `as never` 를 반복하지 않도록 helper 화.
 */
function asChildProcess(fake: FakeChildProcess): ChildProcess {
  return fake as unknown as ChildProcess;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

/**
 * child_process.spawn 결과 흉내. exit/error 를 비동기로 emit. opts 비면 emit 없음 (수동 제어용).
 * 실제 Node ChildProcess 는 exit 직후 close 도 emit 하므로 fake 도 동일하게 emit —
 * runExec 가 향후 close 를 듣게 되어도 hang 없이 동작.
 * 한계: 같은 setImmediate 안에서 exit/close 둘 다 emit 하므로 두 이벤트 사이의 microtask
 * 간격은 모방하지 못한다 (production 은 stdio 정리 후 close 가 더 늦게 emit).
 */
function fakeChild(opts: {
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: Error;
}): FakeChildProcess {
  const ee = new EventEmitter() as FakeChildProcess;
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn();
  if (opts.exit || opts.error) {
    setImmediate(() => {
      if (opts.error) ee.emit('error', opts.error);
      else if (opts.exit) {
        ee.emit('exit', opts.exit.code, opts.exit.signal);
        // 실제 ChildProcess lifecycle: exit → close (stdio 닫힘 후).
        // 같은 tick 에 emit 해도 runExec 의 listener (exit only) 가 먼저 settle 한다.
        ee.emit('close', opts.exit.code, opts.exit.signal);
      }
    });
  }
  return ee;
}

/** runExec 가 process.on('SIGINT'...) 으로 등록한 forwarder 를 가져온다 (마지막 listener). */
function latestSignalListener(sig: NodeJS.Signals): (received: NodeJS.Signals) => void {
  const handlers = process.listeners(sig);
  if (handlers.length === 0) throw new Error(`${sig} listener 가 등록되지 않음`);
  return handlers[handlers.length - 1] as (received: NodeJS.Signals) => void;
}

describe('runExec', () => {
  let release: ReturnType<typeof vi.fn>;
  let savedAmbientEnv: { OPENAI_API_KEY?: string; CODEX_HOME?: string };

  beforeEach(() => {
    savedAmbientEnv = {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      CODEX_HOME: process.env.CODEX_HOME
    };
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_HOME;
    vi.clearAllMocks();
    release = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValue(release as () => Promise<void>);
    mockWithCliMutationLock.mockImplementation(async (opts, fn) => {
      const releaseFn = await mockAcquire(opts.cliId, opts.profileName, {
        execMode: opts.execMode,
        affectsCliIds: opts.affectsCliIds
      });
      let previousActive = opts.previousActive;
      try {
        if (opts.prepareMetadata) {
          const prepared = await opts.prepareMetadata();
          previousActive = prepared.previousActive ?? previousActive;
        }
      } catch (err) {
        await releaseFn();
        throw err;
      }
      try {
        return await fn({
          body: {
            pid: process.pid,
            startedAt: 'test-now',
            profile: opts.profileName,
            token: 'test-token',
            execMode: opts.execMode,
            previousActive,
            affectsCliIds: opts.affectsCliIds
          }
        });
      } finally {
        await releaseFn();
      }
    });
    mockFindCliDef.mockReturnValue(FAKE_CLI_DEF);
    mockGetActive.mockResolvedValue('default');
    mockProfileExists.mockResolvedValue(true);
    mockSwitch.mockResolvedValue(FAKE_SWITCH);
    mockSnapshot.mockResolvedValue(FAKE_SNAPSHOT);
  });

  afterEach(() => {
    restoreEnvVar('OPENAI_API_KEY', savedAmbientEnv.OPENAI_API_KEY);
    restoreEnvVar('CODEX_HOME', savedAmbientEnv.CODEX_HOME);
    vi.clearAllMocks();
  });

  it('성공: swap → spawn (exit 0) → restore → release 순으로 호출', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: ['hi']
    });

    expect(result).toEqual({ code: 0, signal: null, restoreError: undefined });
    expect(mockSwitch).toHaveBeenNthCalledWith(1, 'codex', 'work');
    // PR-I*: restore 는 skipPreSwapSnapshot=true 로 호출 (recapture 가 이미 snapshot 했으므로 중복 회피)
    expect(mockSwitch).toHaveBeenNthCalledWith(2, 'codex', 'default', { skipPreSwapSnapshot: true });
    expect(release).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith('echo', ['hi'], { stdio: 'inherit' });
  });

  it('ambient env warning 을 stderr 에 출력하되 실행은 계속하고 값은 노출하지 않음', async () => {
    const oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret-value-must-not-appear';
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    try {
      const result = await runExec({
        cliId: 'codex', profileName: 'work', command: 'echo', args: []
      });
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');

      expect(result.code).toBe(0);
      expect(stderr).toMatch(/ambient credential\/config warning for codex/);
      expect(stderr).toMatch(/OPENAI_API_KEY/);
      expect(stderr).toMatch(/mat support codex/);
      expect(stderr).not.toContain('sk-secret-value-must-not-appear');
      expect(mockSpawn).toHaveBeenCalledOnce();
    } finally {
      if (oldOpenAi == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAi;
      stderrSpy.mockRestore();
    }
  });

  it('ambient cwd 검사 자체가 실패해도 stderr warning 후 실행은 계속함', async () => {
    mockFindCliDef.mockReturnValue({ ...FAKE_CLI_DEF, id: 'aider', name: 'Aider (fixture)' });
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd unavailable');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    try {
      const result = await runExec({
        cliId: 'aider', profileName: 'work', command: 'echo', args: []
      });
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');

      expect(result.code).toBe(0);
      expect(stderr).toMatch(/ambient credential\/config warning for aider/);
      expect(stderr).toMatch(/could not inspect cwd/);
      expect(mockSpawn).toHaveBeenCalledOnce();
    } finally {
      cwdSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('already-active: swap/restore 모두 skip, spawn 만 실행', async () => {
    mockGetActive.mockResolvedValue('work');
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    });

    expect(result.code).toBe(0);
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('자식이 non-zero 로 종료: code 반환 + restore 수행', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 42, signal: null } })));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'false', args: []
    });

    expect(result.code).toBe(42);
    expect(mockSwitch).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('자식이 시그널로 종료: signal 반환 + restore 수행', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: null, signal: 'SIGINT' } })));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'sleep', args: ['100']
    });

    expect(result.signal).toBe('SIGINT');
    expect(result.code).toBeNull();
    expect(mockSwitch).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('spawn error: throw + restore 수행 + release 수행', async () => {
    const spawnErr = new Error('ENOENT: no such file');
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ error: spawnErr })));

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'nosuchbin', args: []
    })).rejects.toThrow('ENOENT');

    expect(mockSwitch).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('활성 프로필 미설정: lock 안 previousActive 준비 단계에서 UsageError + cleanup release', async () => {
    mockGetActive.mockResolvedValue(undefined);

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    })).rejects.toThrow(UsageError);

    expect(mockAcquire).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('알 수 없는 cli: UsageError', async () => {
    mockFindCliDef.mockReturnValue(undefined);
    await expect(runExec({
      cliId: 'unknown', profileName: 'work', command: 'echo', args: []
    })).rejects.toThrow(UsageError);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('빈 command: UsageError', async () => {
    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: '', args: []
    })).rejects.toThrow(UsageError);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('lock 안에서 profile 미존재: UsageError, swap/spawn 안 함, release 는 호출', async () => {
    mockProfileExists.mockResolvedValue(false);
    await expect(runExec({
      cliId: 'codex', profileName: 'gone', command: 'echo', args: []
    })).rejects.toThrow(UsageError);
    expect(mockAcquire).toHaveBeenCalledOnce();
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('restore 실패: child 결과는 보존하면서 restoreError 채워짐', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    mockSwitch
      .mockResolvedValueOnce(FAKE_SWITCH)
      .mockRejectedValueOnce(new Error('keychain access denied'));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    });

    expect(result.code).toBe(0);
    expect(result.restoreError).toBeInstanceOf(Error);
    expect(result.restoreError?.message).toContain('keychain');
    expect(release).toHaveBeenCalledOnce();
  });

  it('LockHeldError 가 진짜 클래스 그대로 전파됨 (partial mock)', async () => {
    // partial mock 덕분에 진짜 LockHeldError 의 exitCode/holder shape 까지 검증.
    // satisfies 로 LockBody contract 검증 — 필수 필드 누락 시 컴파일 에러.
    const holder = {
      pid: 12345, profile: 'other', startedAt: 'now', token: 'x'
    } satisfies LockHeldError['holder'];
    mockAcquire.mockRejectedValue(new LockHeldError('codex', holder));

    const promise = runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    });
    await expect(promise).rejects.toBeInstanceOf(LockHeldError);
    try {
      await promise;
    } catch (err) {
      expect(err).toBeInstanceOf(LockHeldError);
      const lhe = err as LockHeldError;
      expect(lhe.exitCode).toBe(75);  // 진짜 클래스의 readonly exitCode
      expect(lhe.cliId).toBe('codex');
      expect(lhe.holder.pid).toBe(12345);
    }
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('lock release 완료 이후, forwarder dispose 가 호출된다 (listener identity + async timing)', async () => {
    // 두 가지 false-positive 위험을 모두 차단:
    //  1) 'removeListener' meta-event 가 다른 코드의 SIGINT listener 제거에 반응할 위험 →
    //     'newListener' 로 runExec 가 등록한 함수를 capture, removeListener 시 identity 비교.
    //  2) release 가 sync push 만 하면 production 의 await 누락 회귀를 못 잡을 위험 →
    //     release 가 'release:start' → setImmediate yield → 'release:done' 마커 push.
    //     await release() 가 정확히 동작해야만 dispose 가 release:done 다음에 온다.
    const callOrder: string[] = [];
    mockSwitch.mockImplementation(async (_cli, profile) => {
      callOrder.push(`switch:${profile}`);
      return FAKE_SWITCH;
    });
    mockSnapshot.mockImplementation(async (_cli, profile) => {
      callOrder.push(`snapshot:${profile}`);
      return { ...FAKE_SNAPSHOT, profileName: profile };
    });
    release.mockImplementation(async () => {
      callOrder.push('release:start');
      await new Promise((r) => setImmediate(r));
      callOrder.push('release:done');
    });
    mockSpawn.mockImplementation(() => {
      callOrder.push('spawn');
      return asChildProcess(fakeChild({ exit: { code: 0, signal: null } }));
    });

    // runExec 가 SIGINT 에 등록한 정확한 forwarder handler 만 capture (identity check).
    let forwarder: ((...args: unknown[]) => void) | undefined;
    const onAdd = (event: string | symbol, handler: (...args: unknown[]) => void) => {
      if (event === 'SIGINT' && !forwarder) forwarder = handler;
    };
    const onRemove = (event: string | symbol, handler: (...args: unknown[]) => void) => {
      if (event === 'SIGINT' && handler === forwarder) callOrder.push('dispose:SIGINT');
    };
    process.on('newListener', onAdd);
    process.on('removeListener', onRemove);

    try {
      await runExec({
        cliId: 'codex', profileName: 'work', command: 'echo', args: []
      });
      // PR-I*: spawn 종료 후 snapshot(swap-target) → switch(previousActive) 순.
      expect(callOrder).toEqual([
        'switch:work', 'spawn',
        'snapshot:work',     // ← PR-I*: 라이브 재캡처 (rotation 흡수)
        'switch:default',    // ← restore (skipPreSwapSnapshot=true)
        'release:start', 'release:done',
        'dispose:SIGINT'
      ]);
    } finally {
      process.removeListener('newListener', onAdd);
      process.removeListener('removeListener', onRemove);
    }
  });

  // ---- Quad-review 합의 후 보강된 케이스들 ----

  it('초기 swap (switchProfile) 실패: throw + spawn skip + lock release 보장', async () => {
    mockSwitch.mockRejectedValueOnce(new Error('keychain locked at swap'));

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    })).rejects.toThrow('keychain locked at swap');

    expect(mockSpawn).not.toHaveBeenCalled();
    // 핵심: swap 실패해도 lock 회수 (Quad-review Finding T — Forge-2 HIGH)
    expect(release).toHaveBeenCalledOnce();
    // restore 도 호출 안 됨 — swap 미완료 상태라 의도된 동작
    expect(mockSwitch).toHaveBeenCalledTimes(1);
  });

  it('child non-zero + restore 실패: child code 보존 + restoreError 포함', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 17, signal: null } })));
    mockSwitch
      .mockResolvedValueOnce(FAKE_SWITCH)
      .mockRejectedValueOnce(new Error('restore boom'));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'false', args: []
    });

    expect(result.code).toBe(17);  // child 결과 우선 보존
    expect(result.restoreError?.message).toContain('restore boom');
    expect(release).toHaveBeenCalledOnce();
  });

  it('spawn error + restore 실패: spawn error 가 throw 됨 (restoreError 는 surface 안 됨)', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ error: new Error('ENOENT: no such file') })));
    mockSwitch
      .mockResolvedValueOnce(FAKE_SWITCH)
      .mockRejectedValueOnce(new Error('restore boom'));

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'nosuchbin', args: []
    })).rejects.toThrow('ENOENT');

    expect(mockSwitch).toHaveBeenCalledTimes(2);  // swap + restore 시도
    expect(release).toHaveBeenCalledOnce();
  });

  it('SIGINT forwarder 가 자식에게 신호 전달 (process listener 직접 invoke)', async () => {
    // runExec 가 register 한 SIGINT listener 를 잡아 invoke 하고, 그 결과 child.kill('SIGINT') 가
    // 호출되는지 검증 (Quad-review Finding S — Forge-2 HIGH).
    const child = fakeChild({});  // exit/error 자동 emit 없음 — 수동 제어
    mockSpawn.mockImplementation(() => {
      // spawn 시점에 childRef.current = child 가 채워짐. 그 직후 forwarder invoke.
      setImmediate(() => {
        latestSignalListener('SIGINT')('SIGINT');
        // 그 다음 tick 에 child 가 SIGINT 받고 종료된 척 emit → runExec 종결
        setImmediate(() => child.emit('exit', null, 'SIGINT'));
      });
      return asChildProcess(child);
    });

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'sleep', args: ['100']
    });

    expect(child.kill).toHaveBeenCalledWith('SIGINT');
    expect(result.signal).toBe('SIGINT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('runExec 종료 후 SIGINT listener 가 dispose 된다 (leak 방지)', async () => {
    const before = process.listeners('SIGINT').length;
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });
    const after = process.listeners('SIGINT').length;
    expect(after).toBe(before);  // 등록 = 해제
  });

  // ---- PR-I* — rotation 재캡처 + LockBody.previousActive 전달 ----

  it('PR-I*: lock 획득 후 previousActive 를 준비하고 execMode/affectsCliIds 를 전달', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

    expect(mockAcquire).toHaveBeenCalledWith('codex', 'work', {
      execMode: 'exec',
      affectsCliIds: ['codex']
    });
    expect(mockGetActive).toHaveBeenCalled();
  });

  it('previousActive 는 lock 획득 이후 읽은 값으로 metadata/restore 에 사용된다 (TOCTOU 회귀)', async () => {
    mockGetActive.mockResolvedValue('personal');
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

    expect(mockAcquire.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetActive.mock.invocationCallOrder[0]
    );
    expect(mockSwitch).toHaveBeenNthCalledWith(1, 'codex', 'work');
    expect(mockSwitch).toHaveBeenNthCalledWith(
      2,
      'codex',
      'personal',
      { skipPreSwapSnapshot: true }
    );
  });

  it('PR-I*: swap 성공 후 cmd 종료 시 snapshotLiveToProfile(cliId, swap-target) 가 호출되어 라이브 재캡처', async () => {
    // 실시나리오: codex cmd 가 자체적으로 OAuth refresh rotation. 라이브에 새 토큰이 남아 있으므로
    // swap-target ('work') profile 로 재캡처해야 손실 없음.
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    await runExec({ cliId: 'codex', profileName: 'work', command: 'codex', args: ['ask'] });

    expect(mockSnapshot).toHaveBeenCalledOnce();
    expect(mockSnapshot).toHaveBeenCalledWith('codex', 'work');
  });

  it('PR-I*: restore (previousActive 로 switchProfile) 가 skipPreSwapSnapshot:true 옵션과 함께 호출됨', async () => {
    // 재캡처 단계에서 이미 snapshot 했으므로 switchProfile 내부 snapshot 중복 회피.
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

    // 1번째 호출 = swap (skipPreSwapSnapshot 없음), 2번째 호출 = restore (skipPreSwapSnapshot=true)
    expect(mockSwitch).toHaveBeenNthCalledWith(1, 'codex', 'work');
    expect(mockSwitch).toHaveBeenNthCalledWith(2, 'codex', 'default', { skipPreSwapSnapshot: true });
  });

  it('PR-I*: 재캡처 (snapshotLiveToProfile) 실패 → stderr 안내 + restore 는 진행됨', async () => {
    // best-effort 흐름 회귀 가드. 재캡처 실패해도 restore 가 호출되어 활성 포인터 원복.
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    mockSnapshot.mockRejectedValueOnce(new Error('keychain locked during recapture'));
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const result = await runExec({
        cliId: 'codex', profileName: 'work', command: 'echo', args: []
      });
      expect(result.code).toBe(0);
      // restore 는 여전히 호출됨 — switch 호출 횟수 = swap + restore = 2
      expect(mockSwitch).toHaveBeenCalledTimes(2);
      expect(mockSwitch).toHaveBeenNthCalledWith(2, 'codex', 'default', { skipPreSwapSnapshot: true });
      // 사용자 안내 stderr 확인 — quad-review iter 1 Split LOW (Claude-1/2 합의) fix:
      // restore 실패 안내와 일관되게 후속 action (`mat freshness <cli>`) 권장 문구 포함.
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(stderr).toMatch(/swap 프로필\(work\) 의 라이브 재캡처 실패/);
      expect(stderr).toMatch(/keychain locked during recapture/);
      expect(stderr).toMatch(/mat freshness codex/);
      // restore 자체는 성공이므로 restoreError 는 undefined
      expect(result.restoreError).toBeUndefined();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('PR-I*: already-active (previousActive === target) → snapshot/restore 모두 skip', async () => {
    // 기존 already-active 시나리오와 동일 — swap 자체가 일어나지 않으므로 PR-I* 재캡처도 skip.
    mockGetActive.mockResolvedValue('work');
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockSwitch).not.toHaveBeenCalled();
  });

  it.each<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    'PR-I*: %s forwarder 도 자식에게 신호 전달 후 재캡처 + restore (FORWARD_SIGNALS 매트릭스, quad-review Split LOW fix)',
    async (sig) => {
      // plan §198 의 trap 가능 signal (SIGINT/SIGTERM/SIGHUP) 매트릭스 회귀 가드.
      // table-driven 으로 FORWARD_SIGNALS 변경 시 자동 감지. 기존 SIGINT 단일 케이스
      // (listener identity 검증) 와 별개로, 본 매트릭스는 finally invariant (재캡처 +
      // restore) 가 모든 trap 가능 signal 에서 보존됨을 검증.
      const child = fakeChild({});
      mockSpawn.mockImplementation(() => {
        setImmediate(() => {
          latestSignalListener(sig)(sig);
          setImmediate(() => child.emit('exit', null, sig));
        });
        return asChildProcess(child);
      });

      const result = await runExec({
        cliId: 'codex', profileName: 'work', command: 'sleep', args: ['100']
      });

      expect(child.kill).toHaveBeenCalledWith(sig);
      expect(result.signal).toBe(sig);
      // signal 이후에도 재캡처 + restore 가 모두 실행됨 (PR-I* finally invariant)
      expect(mockSnapshot).toHaveBeenCalledOnce();
      expect(mockSwitch).toHaveBeenCalledTimes(2);  // swap + restore
      expect(release).toHaveBeenCalledOnce();
    }
  );

  it('PR-I*: snapshotLiveToProfile 가 hang 하면 RECAPTURE_TIMEOUT_MS 후 timeout → stderr 안내 + restore 진행 (quad-review Strong MED fix)', async () => {
    // quad-review iter 1 Strong MED (Codex-2 + Claude-2 합의): recapture 가 keychain
    // prompt / NFS stall 등으로 hang 시 finally 전체 차단 → mat 종료 안 됨. timeout
    // 도입으로 bounded — timeout 후 stderr 안내 + restore 정상 진행.
    //
    // fake timers 로 RECAPTURE_TIMEOUT_MS (10s default) advance. snapshotLiveToProfile
    // mock 는 영원히 pending → withTimeout race 의 timeoutPromise 가 먼저 reject.
    vi.useFakeTimers();
    try {
      mockSnapshot.mockImplementationOnce(() => new Promise(() => { /* never settle */ }));
      mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const runPromise = runExec({
        cliId: 'codex', profileName: 'work', command: 'sleep', args: []
      });
      // RECAPTURE_TIMEOUT_MS (10s) 충분히 초과해 timeout reject 유발.
      await vi.advanceTimersByTimeAsync(11_000);
      const result = await runPromise;

      expect(result.code).toBe(0);
      // restore 는 timeout 후에도 호출됨 — swap + restore = 2회.
      expect(mockSwitch).toHaveBeenCalledTimes(2);
      expect(mockSwitch).toHaveBeenNthCalledWith(2, 'codex', 'default', { skipPreSwapSnapshot: true });

      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(stderr).toMatch(/swap 프로필\(work\) 의 라이브 재캡처 실패/);
      expect(stderr).toMatch(/timeout after 10000ms/);
      expect(stderr).toMatch(/mat freshness codex/);
      stderrSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('PR-N: MAT_EXEC_RECAPTURE_TIMEOUT_MS 의 lazy 평가 — module-load 후 set 한 env 도 즉시 반영', async () => {
    // 옛 코드: const RECAPTURE_TIMEOUT_MS = parseRecaptureTimeoutMs() 가 module load 시점
    // 1회 평가 → test setup 이 env 변경해도 무효, 항상 default 10s 사용.
    // PR-N: getRecaptureTimeoutMs() 호출 시점 평가 → env 변경 즉시 반영. daemon/TUI
    // 통합 시 다음 mat exec 부터 새 timeout 적용.
    vi.useFakeTimers();
    const originalEnv = process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
    process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = '500';
    try {
      mockSnapshot.mockImplementationOnce(() => new Promise(() => { /* never settle */ }));
      mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      const runPromise = runExec({
        cliId: 'codex', profileName: 'work', command: 'sleep', args: []
      });
      // override 한 500ms 만 지나도 timeout reject 가 발생해야 함 (옛 코드면 10s 까지 안 됨).
      await vi.advanceTimersByTimeAsync(600);
      const result = await runPromise;

      expect(result.code).toBe(0);
      const stderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(stderr).toMatch(/timeout after 500ms/);
      stderrSpy.mockRestore();
    } finally {
      if (originalEnv === undefined) {
        delete process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS;
      } else {
        process.env.MAT_EXEC_RECAPTURE_TIMEOUT_MS = originalEnv;
      }
      vi.useRealTimers();
    }
  });

  it('PR-I*: spawn error 후에도 재캡처 + restore 모두 시도됨 (rotation 손실 방지)', async () => {
    // spawn error (예: 자식 ENOENT) 라도 swap 은 이미 완료된 상태. 라이브에 cmd 가 일부 토큰을
    // 갱신했을 수 있으므로 재캡처는 시도해야 함. 그 후 restore 도 진행.
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ error: new Error('ENOENT') })));

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'nosuchbin', args: []
    })).rejects.toThrow('ENOENT');

    expect(mockSnapshot).toHaveBeenCalledOnce();
    expect(mockSnapshot).toHaveBeenCalledWith('codex', 'work');
    expect(mockSwitch).toHaveBeenCalledTimes(2);  // swap + restore
  });

  it('spawn error 와 exit 이 중복 전달돼도 첫 settle 결과만 사용한다', async () => {
    const listeners: Record<string, (...args: unknown[]) => void> = {};
    const child = {
      exitCode: null,
      signalCode: null,
      kill: vi.fn(),
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        listeners[event] = cb;
        return child;
      }),
      // 실제 ChildProcess 는 listener 를 제거하지만, 여기서는 의도적으로 no-op 처리해 두 번째
      // 이벤트가 settle guard(`if (settled) return`) 를 직접 통과하게 만든다.
      removeAllListeners: vi.fn(() => child)
    } as unknown as FakeChildProcess;
    const firstError = new Error('first spawn error');
    mockSpawn.mockImplementation(() => {
      setImmediate(() => {
        listeners.error(firstError);
        listeners.exit(0, null);
      });
      return asChildProcess(child);
    });

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'flaky-child', args: []
    })).rejects.toThrow('first spawn error');

    expect(mockSnapshot).toHaveBeenCalledOnce();
    expect(mockSwitch).toHaveBeenCalledTimes(2); // spawn error 이후에도 recapture + restore
    expect(release).toHaveBeenCalledOnce();
  });

  it('SIGINT forwarder: child 생성 전 신호는 안전하게 무시된다', async () => {
    const child = fakeChild({ exit: { code: 0, signal: null } });
    mockAcquire.mockImplementation(async () => {
      latestSignalListener('SIGINT')('SIGINT');
      return release as () => Promise<void>;
    });
    mockSpawn.mockReturnValue(asChildProcess(child));

    const result = await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

    expect(result.code).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('SIGTERM forwarder: 이미 종료 표시된 child 에는 신호를 보내지 않는다', async () => {
    const child = fakeChild({});
    mockSpawn.mockImplementation(() => {
      setImmediate(() => {
        child.exitCode = 0;
        latestSignalListener('SIGTERM')('SIGTERM');
        child.emit('exit', 0, null);
      });
      return asChildProcess(child);
    });

    const result = await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

    expect(result.code).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('restore 가 non-Error 값을 reject 해도 Error 로 감싸 restoreError 에 보존한다', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    mockSwitch
      .mockResolvedValueOnce(FAKE_SWITCH)
      .mockRejectedValueOnce('restore string failure');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      const result = await runExec({ cliId: 'codex', profileName: 'work', command: 'echo', args: [] });

      expect(result.code).toBe(0);
      expect(result.restoreError).toBeInstanceOf(Error);
      expect(result.restoreError?.message).toBe('restore string failure');
    } finally {
      stderrSpy.mockRestore();
    }
  });

});
