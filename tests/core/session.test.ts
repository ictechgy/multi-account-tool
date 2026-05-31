/**
 * PR-S3: runSession / listSessions / stopSession / reapOrphans 단위 테스트.
 *
 * Mock 전략 (exec.test.ts 미러):
 *  - cli-defs(findCliDef) / profile-store(validate/exists/read/write) / node:child_process(spawn): mock.
 *  - lockfile: partial mock — isProcessAlive/sanitizeForStderr 는 실제, acquireCliLock 만 spy
 *    (전역 무간섭 단언용).
 *  - switcher/config: mock — runSession 이 절대 호출하지 않음을 단언(전역 회귀 0, driver 2).
 *  - paths/io-atomic/session 자체: 실제 — 임시 HOME 에 진짜 세션 디렉토리/격리본 생성.
 */

import { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliDef } from '../../src/core/types.js';

vi.mock('../../src/core/cli-defs.js', () => ({ findCliDef: vi.fn() }));
vi.mock('../../src/core/profile-store.js', () => ({
  validateProfileName: vi.fn((n: string) => n),
  profileExists: vi.fn(),
  readProfileFile: vi.fn(),
  writeProfileFile: vi.fn(),
  // 종료 재캡처 2-phase commit (H1) — stage→commit. stage 는 staging 경로를 반환.
  stageProfileFile: vi.fn(),
  commitStagedFile: vi.fn(),
  discardStagedFile: vi.fn(),
  removeProfileFile: vi.fn()
}));
vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('../../src/core/switcher.js', () => ({ switchProfile: vi.fn(), snapshotLiveToProfile: vi.fn() }));
vi.mock('../../src/core/config.js', () => ({ getActiveProfile: vi.fn(), setActiveProfile: vi.fn() }));
vi.mock('../../src/core/lockfile.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/core/lockfile.js')>(
    '../../src/core/lockfile.js'
  );
  return { ...actual, acquireCliLock: vi.fn() };
});

import { spawn } from 'node:child_process';

import { findCliDef } from '../../src/core/cli-defs.js';
import { UsageError } from '../../src/core/errors.js';
import { acquireCliLock } from '../../src/core/lockfile.js';
import { sessionDir, sessionsDir } from '../../src/core/paths.js';
import {
  commitStagedFile,
  profileExists,
  readProfileFile,
  stageProfileFile,
  writeProfileFile
} from '../../src/core/profile-store.js';
import { listSessions, reapOrphans, runSession, stopSession } from '../../src/core/session.js';
import { switchProfile } from '../../src/core/switcher.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const mockFindCliDef = vi.mocked(findCliDef);
const mockProfileExists = vi.mocked(profileExists);
const mockReadProfile = vi.mocked(readProfileFile);
const mockWriteProfile = vi.mocked(writeProfileFile);
const mockStage = vi.mocked(stageProfileFile);
const mockCommit = vi.mocked(commitStagedFile);
const mockSpawn = vi.mocked(spawn);
const mockSwitch = vi.mocked(switchProfile);
const mockAcquire = vi.mocked(acquireCliLock);

const DEF = {
  id: 'codex',
  name: 'Codex (fixture)',
  sources: [{ type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }],
  session: { roots: [{ env: 'CODEX_HOME', base: '~/.codex' }] }
} satisfies CliDef;

type FakeChildProcess = EventEmitter & {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
};

function asChildProcess(fake: FakeChildProcess): ChildProcess {
  return fake as unknown as ChildProcess;
}

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
      else if (opts.exit) ee.emit('exit', opts.exit.code, opts.exit.signal);
    });
  }
  return ee;
}

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await setupTmpHome();
  vi.clearAllMocks();
  mockFindCliDef.mockReturnValue(DEF);
  mockProfileExists.mockResolvedValue(true);
  mockReadProfile.mockResolvedValue('TOK');
  mockWriteProfile.mockResolvedValue(undefined);
  mockStage.mockResolvedValue('/stub/staged'); // staging 경로 stub (commit 도 mock)
  mockCommit.mockResolvedValue(undefined);
  mockAcquire.mockResolvedValue(vi.fn() as never);
});
afterEach(async () => {
  await tmp.cleanup();
});

describe('runSession', () => {
  it('성공: subshell spawn(env 에 CODEX_HOME + MAT_SESSION) → exit 0 → 재캡처 → 세션 디렉토리 삭제', async () => {
    mockSpawn.mockImplementation(() => asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));

    const result = await runSession({ cliId: 'codex', profileName: 'work' });

    expect(result).toEqual({ code: 0, signal: null, recaptureError: undefined });
    const [cmd, args, options] = mockSpawn.mock.calls[0];
    expect(typeof cmd).toBe('string'); // SHELL || /bin/sh
    expect(args).toEqual([]);
    expect((options as { stdio: string }).stdio).toBe('inherit');
    const env = (options as { env: Record<string, string> }).env;
    expect(env.MAT_SESSION).toMatch(/^codex-work-[0-9a-f]{8}$/);
    expect(env.CODEX_HOME).toContain(join('.multi-account-tool', 'sessions'));
    // 재캡처(2-phase stage→commit) 호출됨 + 세션 디렉토리 정리됨
    expect(mockStage).toHaveBeenCalledWith('codex', 'work', 'auth.json', 'TOK');
    expect(mockCommit).toHaveBeenCalled();
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('미지원 CLI (session 미정의) → UsageError, spawn/materialize 미실행', async () => {
    mockFindCliDef.mockReturnValue({ id: 'gemini', name: 'Gemini', sources: [] });
    await expect(runSession({ cliId: 'gemini', profileName: 'work' })).rejects.toBeInstanceOf(
      UsageError
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('알 수 없는 CLI → UsageError', async () => {
    mockFindCliDef.mockReturnValue(undefined);
    await expect(runSession({ cliId: 'nope', profileName: 'work' })).rejects.toBeInstanceOf(
      UsageError
    );
  });

  it('자격증명 부재 → 에러 + 세션 디렉토리 미잔류', async () => {
    mockReadProfile.mockResolvedValue(null);
    await expect(runSession({ cliId: 'codex', profileName: 'work' })).rejects.toThrow();
    expect(mockSpawn).not.toHaveBeenCalled();
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it.each<NodeJS.Signals>(['SIGINT', 'SIGTERM', 'SIGHUP'])(
    'child 시그널 종료(%s) → signal 반환 + 재캡처/정리 수행',
    async (sig) => {
      mockSpawn.mockImplementation(() => asChildProcess(fakeChild({ exit: { code: null, signal: sig } })));
      const result = await runSession({ cliId: 'codex', profileName: 'work' });
      expect(result.signal).toBe(sig);
      expect(mockStage).toHaveBeenCalled();
      await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
    }
  );

  it('재캡처 실패 → recaptureError 설정 + 세션 디렉토리 삭제 + spawn 결과 보존', async () => {
    mockSpawn.mockImplementation(() => asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    mockCommit.mockRejectedValue(new Error('disk full')); // commit 단계 실패 주입
    const result = await runSession({ cliId: 'codex', profileName: 'work' });
    expect(result.code).toBe(0);
    expect(result.recaptureError).toBeInstanceOf(Error);
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('spawn error → throw, 단 재캡처/정리 수행', async () => {
    mockSpawn.mockImplementation(() => asChildProcess(fakeChild({ error: new Error('ENOENT shell') })));
    await expect(runSession({ cliId: 'codex', profileName: 'work' })).rejects.toThrow(/ENOENT/);
    await expect(fs.readdir(sessionsDir())).resolves.toEqual([]);
  });

  it('forwarder dispose: 종료 후 SIGINT/SIGTERM/SIGHUP listener leak 0', async () => {
    const before = (['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]).map((s) =>
      process.listenerCount(s)
    );
    mockSpawn.mockImplementation(() => asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    await runSession({ cliId: 'codex', profileName: 'work' });
    const after = (['SIGINT', 'SIGTERM', 'SIGHUP'] as NodeJS.Signals[]).map((s) =>
      process.listenerCount(s)
    );
    expect(after).toEqual(before);
  });

  it('전역 무간섭 (driver 2): switchProfile / acquireCliLock 호출 0회', async () => {
    mockSpawn.mockImplementation(() => asChildProcess(fakeChild({ exit: { code: 0, signal: null } })));
    await runSession({ cliId: 'codex', profileName: 'work' });
    expect(mockSwitch).not.toHaveBeenCalled();
    expect(mockAcquire).not.toHaveBeenCalled();
  });
});

describe('listSessions / stopSession / reapOrphans', () => {
  /** sessionsDir 에 가짜 세션 디렉토리 + session.json 직접 생성. */
  async function makeSession(id: string, pid: number, startedAt: string): Promise<string> {
    const dir = sessionDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'session.json'),
      JSON.stringify({ id, cli: 'codex', profile: 'work', pid, startedAt, roots: [] })
    );
    return dir;
  }

  const DEAD_PID = 2147483646; // 사실상 존재하지 않는 pid → isProcessAlive false

  it('listSessions: 살아있는 pid → alive true, 죽은 pid → false', async () => {
    await makeSession('codex-work-aaaaaaaa', process.pid, new Date().toISOString());
    await makeSession('codex-work-bbbbbbbb', DEAD_PID, new Date().toISOString());
    const sessions = await listSessions();
    const byId = Object.fromEntries(sessions.map((s) => [s.id, s.alive]));
    expect(byId['codex-work-aaaaaaaa']).toBe(true);
    expect(byId['codex-work-bbbbbbbb']).toBe(false);
  });

  it('reapOrphans: pid 죽음 + TTL 초과 + 디렉토리 mtime 초과 → 회수', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h 전
    const dir = await makeSession('codex-work-cccccccc', DEAD_PID, old);
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime); // 디렉토리 mtime 도 2h 전
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-cccccccc');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('reapOrphans: 살아있는 세션은 TTL 초과여도 보존', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await makeSession('codex-work-dddddddd', process.pid, old);
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-dddddddd');
  });

  it('reapOrphans: 죽었어도 TTL 내(최근)면 보존', async () => {
    await makeSession('codex-work-eeeeeeee', DEAD_PID, new Date().toISOString());
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-eeeeeeee');
  });

  it('stopSession: 죽은 세션은 디렉토리 정리', async () => {
    const dir = await makeSession('codex-work-ffffffff', DEAD_PID, new Date().toISOString());
    await stopSession('codex-work-ffffffff');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('stopSession: traversal id → throw', async () => {
    await expect(stopSession('../escape')).rejects.toThrow();
  });
});
