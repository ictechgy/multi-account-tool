/**
 * runExec 단위 테스트.
 *
 * 외부 의존성을 모두 vi.mock 으로 격리:
 *  - cli-defs.findCliDef
 *  - config.getActiveProfile
 *  - profile-store.{validateProfileName, profileExists}
 *  - switcher.switchProfile
 *  - lockfile.acquireCliLock
 *  - node:child_process.spawn
 *
 * 시나리오: success / already-active / child non-zero / child signal /
 *           spawn error / missing active / unknown cli / empty cmd /
 *           profile not found inside lock / restore failure /
 *           LockHeldError 전파 / lock release ordering
 */

import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('../../src/core/lockfile.js', () => {
  // 실제 LockHeldError 도 시뮬레이션할 수 있게 가짜 클래스를 노출.
  class LockHeldError extends Error {
    readonly exitCode = 75;
    constructor(public readonly cliId: string, public readonly holder: unknown) {
      super(`lock held: ${cliId}`);
      this.name = 'LockHeldError';
    }
  }
  return {
    acquireCliLock: vi.fn(),
    LockHeldError
  };
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
import { switchProfile } from '../../src/core/switcher.js';

const mockFindCliDef = vi.mocked(findCliDef);
const mockGetActive = vi.mocked(getActiveProfile);
const mockProfileExists = vi.mocked(profileExists);
const mockSwitch = vi.mocked(switchProfile);
const mockAcquire = vi.mocked(acquireCliLock);
const mockSpawn = vi.mocked(spawn);

/** child_process.spawn 결과 흉내. exit 이벤트 또는 error 이벤트를 비동기로 emit. */
function fakeChild(opts: {
  exit?: { code: number | null; signal: NodeJS.Signals | null };
  error?: Error;
}): EventEmitter & { exitCode: number | null; signalCode: NodeJS.Signals | null; kill: ReturnType<typeof vi.fn> } {
  const ee = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: ReturnType<typeof vi.fn>;
  };
  ee.exitCode = null;
  ee.signalCode = null;
  ee.kill = vi.fn();
  setImmediate(() => {
    if (opts.error) ee.emit('error', opts.error);
    else if (opts.exit) ee.emit('exit', opts.exit.code, opts.exit.signal);
  });
  return ee;
}

describe('runExec', () => {
  let release: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    release = vi.fn().mockResolvedValue(undefined);
    mockAcquire.mockResolvedValue(release as () => Promise<void>);
    // 기본값: cli 존재, profile 존재, 활성 'default'
    mockFindCliDef.mockReturnValue({ id: 'codex' } as ReturnType<typeof findCliDef>);
    mockGetActive.mockResolvedValue('default');
    mockProfileExists.mockResolvedValue(true);
    mockSwitch.mockResolvedValue(undefined as unknown as ReturnType<typeof switchProfile> extends Promise<infer T> ? T : never);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('성공: swap → spawn (exit 0) → restore → release 순으로 호출', async () => {
    mockSpawn.mockReturnValue(fakeChild({ exit: { code: 0, signal: null } }) as never);

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: ['hi']
    });

    expect(result).toEqual({ code: 0, signal: null, restoreError: undefined });
    expect(mockSwitch).toHaveBeenNthCalledWith(1, 'codex', 'work');     // swap
    expect(mockSwitch).toHaveBeenNthCalledWith(2, 'codex', 'default');  // restore
    expect(release).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith('echo', ['hi'], { stdio: 'inherit' });
  });

  it('already-active: swap/restore 모두 skip, spawn 만 실행', async () => {
    mockGetActive.mockResolvedValue('work');
    mockSpawn.mockReturnValue(fakeChild({ exit: { code: 0, signal: null } }) as never);

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    });

    expect(result.code).toBe(0);
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it('자식이 non-zero 로 종료: code 반환 + restore 수행', async () => {
    mockSpawn.mockReturnValue(fakeChild({ exit: { code: 42, signal: null } }) as never);

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'false', args: []
    });

    expect(result.code).toBe(42);
    expect(mockSwitch).toHaveBeenCalledTimes(2); // swap + restore
    expect(release).toHaveBeenCalledOnce();
  });

  it('자식이 시그널로 종료: signal 반환 + restore 수행', async () => {
    mockSpawn.mockReturnValue(fakeChild({ exit: { code: null, signal: 'SIGINT' } }) as never);

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'sleep', args: ['100']
    });

    expect(result.signal).toBe('SIGINT');
    expect(result.code).toBeNull();
    expect(mockSwitch).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it('spawn 자체가 error 이벤트로 실패: throw + restore 수행 + release 수행', async () => {
    const spawnErr = new Error('ENOENT: no such file');
    mockSpawn.mockReturnValue(fakeChild({ error: spawnErr }) as never);

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'nosuchbin', args: []
    })).rejects.toThrow('ENOENT');

    // swap 이후 spawn 실패해도 restore + release 는 보장.
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
    expect(release).toHaveBeenCalledOnce(); // finally 에서 release 보장
  });

  it('restore 실패: child 결과는 보존하면서 restoreError 채워짐', async () => {
    mockSpawn.mockReturnValue(fakeChild({ exit: { code: 0, signal: null } }) as never);
    // 첫 번째 (swap) 성공, 두 번째 (restore) 실패
    mockSwitch
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(new Error('keychain access denied'));

    const result = await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    });

    expect(result.code).toBe(0);
    expect(result.restoreError).toBeInstanceOf(Error);
    expect(result.restoreError?.message).toContain('keychain');
    expect(release).toHaveBeenCalledOnce();
  });

  it('LockHeldError 가 그대로 전파, swap/spawn 호출 안 됨', async () => {
    mockAcquire.mockRejectedValue(new LockHeldError('codex', {
      pid: 12345, profile: 'other', startedAt: 'now', token: 'x'
    }));

    await expect(runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    })).rejects.toBeInstanceOf(LockHeldError);

    expect(mockSwitch).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('lock release 는 restore 이후, forwarder dispose 이전에 실행된다', async () => {
    const callOrder: string[] = [];
    mockSwitch.mockImplementation(async (_cli, profile) => {
      callOrder.push(`switch:${profile}`);
    });
    release.mockImplementation(async () => {
      callOrder.push('release');
    });
    mockSpawn.mockImplementation((() => {
      callOrder.push('spawn');
      return fakeChild({ exit: { code: 0, signal: null } });
    }) as never);

    await runExec({
      cliId: 'codex', profileName: 'work', command: 'echo', args: []
    });

    // 기대: swap → spawn → restore → release
    expect(callOrder).toEqual(['switch:work', 'spawn', 'switch:default', 'release']);
  });
});
