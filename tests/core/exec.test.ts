/**
 * runExec 단위 테스트.
 *
 * Mock 전략:
 *  - cli-defs / config / profile-store / switcher / node:child_process: 전부 mock
 *  - lockfile: **partial mock** — 진짜 `LockHeldError` 는 그대로 export 하고
 *    `acquireCliLock` 만 vi.fn() 으로 교체. exec.test.ts 가 실제 LockHeldError contract
 *    (exitCode, holder 시그니처) 를 그대로 검증하도록 보장.
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
  switchProfile: vi.fn()
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
import { switchProfile, type SwitchResult } from '../../src/core/switcher.js';

const mockFindCliDef = vi.mocked(findCliDef);
const mockGetActive = vi.mocked(getActiveProfile);
const mockProfileExists = vi.mocked(profileExists);
const mockSwitch = vi.mocked(switchProfile);
const mockAcquire = vi.mocked(acquireCliLock);
const mockSpawn = vi.mocked(spawn);

/**
 * switchProfile 의 반환 타입을 type alias 로 묶어 mock 캐스팅을 단순화.
 * SwitchResult 시그니처가 바뀌면 이 alias 의 import 자체가 깨져 회귀 감지 가능
 * (`undefined as unknown as ReturnType<typeof switchProfile> extends ...` 패턴은 가림).
 */
type FakeSwitch = SwitchResult;
const FAKE_SWITCH = undefined as unknown as FakeSwitch;

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

  beforeEach(() => {
    vi.clearAllMocks();
    release = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValue(release as () => Promise<void>);
    mockFindCliDef.mockReturnValue(FAKE_CLI_DEF);
    mockGetActive.mockResolvedValue('default');
    mockProfileExists.mockResolvedValue(true);
    mockSwitch.mockResolvedValue(FAKE_SWITCH);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('성공: swap → spawn (exit 0) → restore → release 순으로 호출', async () => {
    mockSpawn.mockReturnValue(asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: ['hi']
    });

    expect(result).toEqual({ code: 0, signal: null, restoreError: undefined });
    expect(mockSwitch).toHaveBeenNthCalledWith(1, 'codex', 'work');
    expect(mockSwitch).toHaveBeenNthCalledWith(2, 'codex', 'default');
    expect(release).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith('echo', ['hi'], { stdio: 'inherit' });
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

  it('활성 프로필 미설정: UsageError, lock/swap/spawn 모두 호출 안 됨', async () => {
    mockGetActive.mockResolvedValue(undefined);

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    })).rejects.toThrow(UsageError);

    expect(mockAcquire).not.toHaveBeenCalled();
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
      expect(callOrder).toEqual([
        'switch:work', 'spawn', 'switch:default',
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
});
