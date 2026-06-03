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
  return { ...actual, acquireCliLock: vi.fn(), acquireRecaptureLock: vi.fn() };
});

import { spawn } from 'node:child_process';

import { findCliDef } from '../../src/core/cli-defs.js';
import { UsageError } from '../../src/core/errors.js';
import { acquireCliLock, acquireRecaptureLock } from '../../src/core/lockfile.js';
import { sessionDir, sessionsDir } from '../../src/core/paths.js';
import {
  commitStagedFile,
  profileExists,
  readProfileFile,
  removeProfileFile,
  stageProfileFile,
  writeProfileFile
} from '../../src/core/profile-store.js';
import {
  listSessions,
  materializeSession,
  mkdirContainedNoSymlink,
  planSession,
  recaptureSession,
  reapOrphans,
  removeSessionDir,
  runSession,
  stopSession
} from '../../src/core/session.js';
import { switchProfile } from '../../src/core/switcher.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const mockFindCliDef = vi.mocked(findCliDef);
const mockProfileExists = vi.mocked(profileExists);
const mockReadProfile = vi.mocked(readProfileFile);
const mockWriteProfile = vi.mocked(writeProfileFile);
const mockStage = vi.mocked(stageProfileFile);
const mockCommit = vi.mocked(commitStagedFile);
const mockRemoveProfile = vi.mocked(removeProfileFile);
const mockSpawn = vi.mocked(spawn);
const mockSwitch = vi.mocked(switchProfile);
const mockAcquire = vi.mocked(acquireCliLock);
const mockAcquireRecapture = vi.mocked(acquireRecaptureLock);

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
  mockRemoveProfile.mockResolvedValue(undefined);
  mockAcquire.mockResolvedValue(vi.fn() as never);
  // 재캡처 락 기본값 — release 핸들 반환(획득 성공). null 폴백은 개별 테스트에서 override.
  mockAcquireRecapture.mockResolvedValue(vi.fn().mockResolvedValue(undefined));
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

describe('planSession / envSubdir — nested base (gemini, PR-0)', () => {
  // gemini 는 GEMINI_CLI_HOME 이 `.gemini` 의 부모를 가리킨다 → envSubdir 로 cred 루트를 한 단계 내림.
  const GEMINI_DEF = {
    id: 'gemini',
    name: 'Gemini (fixture)',
    sources: [
      { type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' },
      { type: 'file', path: '~/.gemini/google_accounts.json', saveAs: 'google_accounts.json' }
    ],
    session: { roots: [{ env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini' }] }
  } satisfies CliDef;

  it('envSubdir 가 cred 격리본 루트를 한 단계 내린다 (<주입dir>/.gemini/<rel>)', () => {
    const id = 'gemini-work-abcd1234';
    const plan = planSession(GEMINI_DEF, 'work', id);
    const root = plan.roots[0];
    const dir = join(sessionDir(id), 'GEMINI_CLI_HOME');
    expect(root.dir).toBe(dir); // env 주입값 = 부모(세션 디렉토리)
    for (const cred of root.creds) {
      // 격리본은 주입 dir 의 .gemini 하위 — gemini 의 getGlobalGeminiDir()=join(homedir,'.gemini') 와 정렬.
      expect(cred.absInSession).toBe(join(dir, '.gemini', cred.rel));
    }
    expect(root.creds.map((c) => c.rel).sort()).toEqual([
      'google_accounts.json',
      'oauth_creds.json'
    ]);
  });

  it('envSubdir 미지정(codex)은 cred 가 주입 dir 직속 — 기존 동작 불변(회귀 가드)', () => {
    const id = 'codex-work-abcd1234';
    const plan = planSession(DEF, 'work', id);
    const root = plan.roots[0];
    const dir = join(sessionDir(id), 'CODEX_HOME');
    expect(root.dir).toBe(dir);
    expect(root.creds[0].absInSession).toBe(join(dir, 'auth.json')); // .gemini 같은 하위 세그먼트 없음
  });

  // traversal/절대/빈값 + 다중 세그먼트('a/b') 거부 — validateEnvSubdir 가 단일 세그먼트 강제(중간
  // 디렉토리 symlink TOCTOU 회피, security 리뷰 L1). 'a/../b' 는 validateShareRel '..' 세그먼트 거부.
  it.each(['../escape', '/abs', 'a/../b', '', 'a/b', 'sub/.gemini'])(
    'envSubdir traversal/절대/빈값/다중세그먼트(%s) 거부 (validateEnvSubdir)',
    (bad) => {
      const badDef = {
        ...GEMINI_DEF,
        session: { roots: [{ env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: bad }] }
      } satisfies CliDef;
      expect(() => planSession(badDef, 'work', 'gemini-work-abcd1234')).toThrow();
    }
  );

  it('materializeSession 이 envSubdir 하위에 격리본을 쓴다 (실제 fs)', async () => {
    const id = 'gemini-work-deadbeef';
    const plan = planSession(GEMINI_DEF, 'work', id);
    await materializeSession(plan); // readProfileFile mock = 'TOK'
    const dir = join(sessionDir(id), 'GEMINI_CLI_HOME');
    await expect(fs.readFile(join(dir, '.gemini', 'oauth_creds.json'), 'utf8')).resolves.toBe('TOK');
    await expect(fs.readFile(join(dir, '.gemini', 'google_accounts.json'), 'utf8')).resolves.toBe(
      'TOK'
    );
    await removeSessionDir(id);
  });

  // code 리뷰 MEDIUM-2: envSubdir + share 조합 branch 커버. 현 빌트인엔 둘을 함께 쓰는 CLI 가 없어
  // (gemini=envSubdir·share∅, codex=share·envSubdir 없음) credRoot 기준 share 복사가 미검증이었다.
  // share 격리본도 cred 와 같은 credRoot(<dir>/envSubdir) 하위에 떨어져야 base 와 1:1 미러된다.
  it('envSubdir + share 조합: share 복사도 credRoot 하위에 떨어진다 (실제 fs)', async () => {
    const id = 'gemini-work-cafe0000';
    // base 에 share 대상 원본을 만들어 둔다(materializeShareCopy 가 base 에서 0600 복사).
    const baseGemini = join(tmp.home, '.gemini');
    await fs.mkdir(baseGemini, { recursive: true });
    await fs.writeFile(join(baseGemini, 'config.json'), '{"cfg":true}');
    const def = {
      ...GEMINI_DEF,
      session: {
        roots: [
          { env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini', share: ['config.json'] }
        ]
      }
    } satisfies CliDef;
    const plan = planSession(def, 'work', id);
    await materializeSession(plan);
    const dir = join(sessionDir(id), 'GEMINI_CLI_HOME');
    // share 복사본이 credRoot(.gemini) 하위에 위치 (root.dir 직속이 아님).
    await expect(fs.readFile(join(dir, '.gemini', 'config.json'), 'utf8')).resolves.toBe('{"cfg":true}');
    await removeSessionDir(id);
  });

  // quad-review agy HIGH(Issue 1) fix 회귀: nested shareRel('sub/app.json')도 credRoot 하위에 정상
  // 복사되고, materializeShareCopy 의 새 assertContainedRealpath(credRoot, copyParent) 봉쇄가 정상
  // 중간 디렉토리(real dir)는 통과시킨다(중간 컴포넌트 symlink escape 만 차단). 단일 세그먼트 share 와
  // 달리 share 는 다중 세그먼트가 허용된다(validateShareRel).
  it('nested share(sub/app.json)도 credRoot 하위에 복사 — realpath 봉쇄가 정상 경로는 통과', async () => {
    const id = 'gemini-work-beef1234';
    const baseGemini = join(tmp.home, '.gemini');
    await fs.mkdir(join(baseGemini, 'sub'), { recursive: true });
    await fs.writeFile(join(baseGemini, 'sub', 'app.json'), '{"nested":1}');
    const def = {
      ...GEMINI_DEF,
      session: {
        roots: [
          { env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini', share: ['sub/app.json'] }
        ]
      }
    } satisfies CliDef;
    await materializeSession(planSession(def, 'work', id));
    const dir = join(sessionDir(id), 'GEMINI_CLI_HOME');
    await expect(fs.readFile(join(dir, '.gemini', 'sub', 'app.json'), 'utf8')).resolves.toBe(
      '{"nested":1}'
    );
    await removeSessionDir(id);
  });

  // quad-review round 2 (Codex MEDIUM) — 음성 회귀: nested share 의 중간 컴포넌트가 symlink 면
  // mkdirContainedNoSymlink 가 추종 전에 throw 하고, escape 대상에 디렉토리를 만들지 않는다.
  it('mkdirContainedNoSymlink: 중간 컴포넌트 symlink 거부 + escape 대상 미생성', async () => {
    const root = join(tmp.home, 'croot');
    const outside = join(tmp.home, 'outside');
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(outside, join(root, 'sub')); // 중간 컴포넌트 'sub' 를 외부로 향하는 symlink 로 사전 배치
    await expect(mkdirContainedNoSymlink(root, join(root, 'sub', 'deep'))).rejects.toThrow();
    // escape 차단 — symlink 를 추종해 outside/deep 을 만들지 않았다.
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });

  it('mkdirContainedNoSymlink: 정상 nested 경로는 컴포넌트별 생성', async () => {
    const root = join(tmp.home, 'croot2');
    await fs.mkdir(root, { recursive: true });
    await mkdirContainedNoSymlink(root, join(root, 'a', 'b'));
    expect((await fs.lstat(join(root, 'a', 'b'))).isDirectory()).toBe(true);
    // 단일 세그먼트(=rootDir 자체)는 no-op.
    await expect(mkdirContainedNoSymlink(root, root)).resolves.toBeUndefined();
  });
});

describe('planSession / gemini — 실제 빌트인 def 의 envSubdir 매핑 (PR-3)', () => {
  // PR-0 은 fixture def 로 envSubdir 동작을 검증했다. 여기선 **실제 BUILTIN_CLI_DEFS 의 gemini**
  // 를 가져와(cli-defs mock 우회 — vi.importActual) 배포되는 def 가 두 cred 를
  // join(dir, '.gemini', rel) 로 매핑함을 고정한다(설정 회귀 가드).

  /** mock 된 cli-defs 를 우회해 실제 빌트인 gemini def 를 읽는다. */
  async function realGeminiDef(): Promise<CliDef> {
    const actual = await vi.importActual<typeof import('../../src/core/cli-defs.js')>(
      '../../src/core/cli-defs.js'
    );
    return actual.BUILTIN_CLI_DEFS.find((c) => c.id === 'gemini')!;
  }

  it('실제 빌트인 gemini def 의 두 cred 가 <주입dir>/.gemini/<rel> 로 매핑된다', async () => {
    const def = await realGeminiDef();
    const id = 'gemini-work-1234abcd';
    const plan = planSession(def, 'work', id);
    const root = plan.roots[0];
    const dir = join(sessionDir(id), 'GEMINI_CLI_HOME');
    expect(root.dir).toBe(dir); // env 주입값 = 부모(세션 디렉토리)
    for (const cred of root.creds) {
      expect(cred.absInSession).toBe(join(dir, '.gemini', cred.rel));
    }
    expect(root.creds.map((c) => c.rel).sort()).toEqual([
      'google_accounts.json',
      'oauth_creds.json'
    ]);
    expect(root.share).toEqual([]); // share=∅ (settings.json write-back 가능성)
  });
});

describe('planSession / claude — keychain 미지원 + linux file 격리 (PR-2)', () => {
  // claude 는 platform-split: linux=file(~/.claude/.credentials.json), macOS=keychain.
  // session 정의는 unconditional 이나, planSession 은 file source 만 격리한다.

  it('keychain source(macOS claude) + session → planSession 이 보강된 메시지로 throw', () => {
    const claudeKeychainDef = {
      id: 'claude',
      name: 'Claude Code (keychain fixture)',
      sources: [{ type: 'keychain', service: 'Claude Code-credentials', saveAs: 'credentials.json' }],
      session: { roots: [{ env: 'CLAUDE_CONFIG_DIR', base: '~/.claude' }] }
    } satisfies CliDef;
    // 비-file source 거부 + keychain/OS-keyring 은 env 리다이렉트로 격리 불가 안내(메시지 보강).
    expect(() => planSession(claudeKeychainDef, 'work', 'claude-work-abcd1234')).toThrow(
      /file source 만 지원|keychain\/OS-keyring/
    );
  });

  it('file source(linux claude) + session → planSession 정상 (base 직속, envSubdir 없음)', () => {
    const claudeFileDef = {
      id: 'claude',
      name: 'Claude Code (file fixture)',
      sources: [{ type: 'file', path: '~/.claude/.credentials.json', saveAs: 'credentials.json' }],
      session: { roots: [{ env: 'CLAUDE_CONFIG_DIR', base: '~/.claude' }] }
    } satisfies CliDef;
    const id = 'claude-work-abcd1234';
    const plan = planSession(claudeFileDef, 'work', id);
    const root = plan.roots[0];
    const dir = join(sessionDir(id), 'CLAUDE_CONFIG_DIR');
    expect(root.dir).toBe(dir);
    // base 직속(envSubdir 없음) → credRoot=dir, 격리본은 dir 직속 credentials.json.
    expect(root.creds).toHaveLength(1);
    expect(root.creds[0].rel).toBe('.credentials.json'); // base 기준 상대경로
    expect(root.creds[0].absInSession).toBe(join(dir, '.credentials.json'));
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

  // 이 파일은 node:child_process 를 mock(execFile 부재) → processStartSignature 가 항상 null →
  // pidStart 가 기록돼 있고 pid 가 살아있으면 classifyOwner='unknown' (서명 조회 실패) (#5).
  async function makeSessionWithMeta(id: string, meta: Record<string, unknown>): Promise<string> {
    const dir = sessionDir(id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'session.json'), JSON.stringify({ id, cli: 'codex', profile: 'work', roots: [], ...meta }));
    return dir;
  }

  it('stopSession: unknown(서명 조회 실패) → SIGTERM·삭제 안 함, 디렉토리 보존 (#5)', async () => {
    const dir = await makeSessionWithMeta('codex-work-unknwn01', {
      pid: process.pid, pidStart: 'RECORDED-SIG', startedAt: new Date().toISOString()
    });
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((p: number, s?: string | number) =>
      s === 0 ? realKill(p, 0) : true) as typeof process.kill);
    try {
      await stopSession('codex-work-unknwn01');
      // liveness probe(signal 0) 외 어떤 종료 신호(SIGTERM/SIGKILL/숫자 등)도 보내지 않음.
      expect(killSpy.mock.calls.filter(([, s]) => s !== 0)).toEqual([]);
      await expect(fs.access(dir)).resolves.toBeUndefined(); // 라이브 가능성 → 디렉토리 보존
    } finally {
      killSpy.mockRestore();
    }
  });

  it('reapOrphans: unknown(서명 조회 실패) + UNKNOWN_TTL 미만(2h) → 보존 (#5, #63-1)', async () => {
    // startedAt·mtime 모두 2h 전 — UNKNOWN_TTL_MS(24h) 미만이라 unknown 세션은 보존된다.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-unknwn02', {
      pid: process.pid, pidStart: 'RECORDED-SIG', startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-unknwn02'); // TTL 미만 → 보존(잘못 삭제 안 함)
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('reapOrphans: unknown + UNKNOWN_TTL 초과(startedAt+mtime 둘 다 25h) → 회수 (#63-1)', async () => {
    // 소유 mat 생존 + 서명 조회 실패 → unknown. startedAt·mtime 둘 다 25h 전(>24h) → 회수.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-unknwn03', {
      pid: process.pid, pidStart: 'RECORDED-SIG', startedAt: old
    });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-unknwn03'); // TTL 초과 → 회수
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('reapOrphans: unknown + startedAt 만 초과(mtime 최근) → 보존 (둘 다 초과만 회수, #63-1)', async () => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-unknwn04', {
      pid: process.pid, pidStart: 'RECORDED-SIG', startedAt: old
    });
    // mtime 은 최근(방금 생성) → 디렉토리 mtime TTL 미초과 → 보존.
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-unknwn04');
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('reapOrphans: MAT_UNKNOWN_SESSION_TTL_MS override(2h) → 2h 초과 unknown 회수 (#63-1)', async () => {
    const prev = process.env.MAT_UNKNOWN_SESSION_TTL_MS;
    process.env.MAT_UNKNOWN_SESSION_TTL_MS = String(2 * 60 * 60 * 1000); // 2h (>=1h 최소값 통과)
    try {
      const old = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(); // 3h 전(>2h)
      const dir = await makeSessionWithMeta('codex-work-unknwn05', {
        pid: process.pid, pidStart: 'RECORDED-SIG', startedAt: old
      });
      const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000);
      await fs.utimes(dir, oldTime, oldTime);
      const reaped = await reapOrphans();
      expect(reaped).toContain('codex-work-unknwn05'); // override TTL(2h) 초과 → 회수
    } finally {
      if (prev === undefined) delete process.env.MAT_UNKNOWN_SESSION_TTL_MS;
      else process.env.MAT_UNKNOWN_SESSION_TTL_MS = prev;
    }
  });

  it('reapOrphans: MAT_UNKNOWN_SESSION_TTL_MS 최소값 미만(30m) 거부 → default 24h 적용, 2h 세션 보존 (#63-1)', async () => {
    const prev = process.env.MAT_UNKNOWN_SESSION_TTL_MS;
    process.env.MAT_UNKNOWN_SESSION_TTL_MS = String(30 * 60 * 1000); // 30m (<1h 최소값 → 거부)
    try {
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(); // 2h 전
      const dir = await makeSessionWithMeta('codex-work-unknwn06', {
        pid: process.pid, pidStart: 'RECORDED-SIG', startedAt: old
      });
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
      await fs.utimes(dir, oldTime, oldTime);
      const reaped = await reapOrphans();
      // 30m override 가 거부되고 default 24h 적용 → 2h 세션은 보존.
      expect(reaped).not.toContain('codex-work-unknwn06');
      await expect(fs.access(dir)).resolves.toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.MAT_UNKNOWN_SESSION_TTL_MS;
      else process.env.MAT_UNKNOWN_SESSION_TTL_MS = prev;
    }
  });

  it('손상된 pid(<=0) 메타는 무시 (#9 — listSessions 제외)', async () => {
    await makeSessionWithMeta('codex-work-badpid01', { pid: 0, startedAt: new Date().toISOString() });
    const sessions = await listSessions();
    expect(sessions.find((s) => s.id === 'codex-work-badpid01')).toBeUndefined();
  });

  // ── #63-2 / #71 결함2·3: 자식 subshell 생존 추적 ──
  // execFile mock-out → processStartSignature=null. 따라서 childPidStart 미기록 + 생존 childPid 는
  // classifyChildOwner 에서 'unknown'(#71 결함2 — liveness-only 'owner' 금지) → reapOrphans 가
  // unknown TTL(24h) bounded 경로로 흘려 무한 보존하지 않는다(#71 결함3). 옛 메타(childPid 부재)는
  // 기존대로 'dead-or-reused' → ORPHAN_TTL(1h).

  it('reapOrphans: 소유 mat 죽음 + 자식 childPidStart 미기록(unknown) + UNKNOWN_TTL 미만(2h) → 보존 (#71 결함2·3)', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-child001', {
      pid: DEAD_PID, // 소유 mat 죽음 → dead-or-reused
      childPid: process.pid, // 자식 생존이나 childPidStart 미기록 → classifyChildOwner='unknown'
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    // child=unknown → 24h TTL. 2h 세션이라 TTL 미만 → 보존(라이브 child 오삭제 방지).
    expect(reaped).not.toContain('codex-work-child001');
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('reapOrphans: 소유 mat 죽음 + 자식 childPidStart 미기록(unknown) + UNKNOWN_TTL 초과(25h) → 회수 (무한 보존 안 함, #71 결함3)', async () => {
    // 결함3 회귀 가드: 서명 없는 childPid(unknown)가 bounded TTL 을 우회해 무한 보존되던 결함 해소.
    // 동일 unknown child 라도 24h 초과면 회수돼야 — startedAt·mtime 둘 다 25h 전.
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-child006', {
      pid: DEAD_PID, // 소유 mat 죽음 → dead-or-reused
      childPid: process.pid, // 생존 childPid 이나 childPidStart 미기록 → unknown
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-child006'); // unknown 도 24h 초과 → bounded 회수
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('reapOrphans: 소유 mat·자식 모두 죽음 + TTL 초과 → 회수 (#63-2)', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-child002', {
      pid: DEAD_PID,
      childPid: DEAD_PID, // 자식도 죽음 → dead-or-reused
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-child002');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('reapOrphans: 옛 메타(childPid 부재) 하위호환 — 기존 로직대로 회수 (#63-2)', async () => {
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const dir = await makeSessionWithMeta('codex-work-child003', {
      pid: DEAD_PID, // 소유 mat 죽음, childPid 없음 → 자식 가드 skip(dead-or-reused 취급)
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-child003'); // 옛 메타 회귀 0 — 기존대로 회수
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('stopSession: dead-or-reused + 자식 unknown(childPidStart 미기록) → 보존 (#63-2, #71 결함2·3)', async () => {
    const dir = await makeSessionWithMeta('codex-work-child004', {
      pid: DEAD_PID, // 소유 mat 죽음 → dead-or-reused
      childPid: process.pid, // 생존 childPid 이나 childPidStart 미기록 → classifyChildOwner='unknown'
      startedAt: new Date().toISOString()
    });
    await stopSession('codex-work-child004');
    // stopSession 은 TTL 없는 명시 종료라 unknown(생존 확정 불가)도 보수적으로 보존(라이브 가능성).
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('stopSession: dead-or-reused + 자식도 죽음 → 정리 (#63-2)', async () => {
    const dir = await makeSessionWithMeta('codex-work-child005', {
      pid: DEAD_PID,
      childPid: DEAD_PID, // 자식도 죽음
      startedAt: new Date().toISOString()
    });
    await stopSession('codex-work-child005');
    await expect(fs.access(dir)).rejects.toThrow(); // 모두 죽음 → 정리
  });
});

/**
 * issue #62: recaptureSession 의 프로필 단위 락 통합 (TOCTOU 차단 + release 순서 불변식).
 *
 * recaptureSession 을 직접 호출해 (1) 락이 backup-read 이전 획득되는지(시나리오 3①),
 * (2) 락 null 폴백 시 경고 1회 + 재캡처 진행, (3) release 가 마지막 commit/rollback 이후에
 * 일어나는지(MAJOR-2, 시나리오 3②)를 spy 호출 인덱스로 검증한다.
 */
describe('recaptureSession — 프로필 단위 락 통합 (#62)', () => {
  /** 락 1개·cred 1개를 가진 최소 SessionPlan + 격리본 파일 생성. 격리본 새 값 반환. */
  async function makePlanWithIsolate(newValue: string) {
    const id = 'codex-work-1a2b3c4d';
    const dir = join(sessionDir(id), 'CODEX_HOME');
    await fs.mkdir(dir, { recursive: true });
    const absInSession = join(dir, 'auth.json');
    await fs.writeFile(absInSession, newValue);
    const plan = {
      id,
      cli: 'codex',
      profile: 'work',
      roots: [
        { env: 'CODEX_HOME', dir, baseAbs: '/base', share: [],
          creds: [{ saveAs: 'auth.json', rel: 'auth.json', absInSession }] }
      ]
    };
    return plan;
  }

  /** 2-cred SessionPlan + 격리본 파일 — 부분 commit 실패 시 rollback 경로 검증용. */
  async function makePlanWith2Creds(v1: string, v2: string) {
    const id = 'codex-work-2c2c2c2c';
    const dir = join(sessionDir(id), 'CODEX_HOME');
    await fs.mkdir(dir, { recursive: true });
    const abs1 = join(dir, 'auth.json');
    const abs2 = join(dir, 'env.json');
    await fs.writeFile(abs1, v1);
    await fs.writeFile(abs2, v2);
    return {
      id,
      cli: 'codex',
      profile: 'work',
      roots: [
        { env: 'CODEX_HOME', dir, baseAbs: '/base', share: [],
          creds: [
            { saveAs: 'auth.json', rel: 'auth.json', absInSession: abs1 },
            { saveAs: 'env.json', rel: 'env.json', absInSession: abs2 }
          ] }
      ]
    };
  }

  it('(11) 락이 첫 backup-read(readProfileFile) 이전에 획득된다 (시나리오 3①)', async () => {
    const order: string[] = [];
    mockAcquireRecapture.mockImplementation(async () => {
      order.push('acquire');
      return vi.fn().mockResolvedValue(undefined);
    });
    mockReadProfile.mockImplementation(async () => {
      order.push('backup-read');
      return 'BACKUP';
    });
    const plan = await makePlanWithIsolate('NEW-TOKEN');
    await recaptureSession(plan as never);
    // 락 호출 인덱스 < 첫 backup-read 호출 인덱스.
    const acquireIdx = order.indexOf('acquire');
    const firstReadIdx = order.indexOf('backup-read');
    expect(acquireIdx).toBeGreaterThanOrEqual(0);
    expect(firstReadIdx).toBeGreaterThanOrEqual(0);
    expect(acquireIdx).toBeLessThan(firstReadIdx);
  });

  it('(12) 락 null 폴백 → stderr 경고 1회 + 재캡처 진행 (best-effort degrade)', async () => {
    mockAcquireRecapture.mockResolvedValue(null); // 락 획득 실패
    const plan = await makePlanWithIsolate('NEW-TOKEN');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await recaptureSession(plan as never);
      const warns = stderrSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => /프로필 락 획득 실패|lock-free/.test(s));
      expect(warns).toHaveLength(1); // 경고 정확히 1회
      // 폴백이어도 재캡처(stage→commit) 는 진행.
      expect(mockStage).toHaveBeenCalledWith('codex', 'work', 'auth.json', 'NEW-TOKEN');
      expect(mockCommit).toHaveBeenCalled();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('(14a) 정상 commit: release 인덱스 > 마지막 commitStagedFile 인덱스 (MAJOR-2)', async () => {
    const order: string[] = [];
    const releaseSpy = vi.fn(async () => { order.push('release'); });
    mockAcquireRecapture.mockResolvedValue(releaseSpy);
    mockCommit.mockImplementation(async () => { order.push('commit'); });
    const plan = await makePlanWithIsolate('NEW-TOKEN');
    await recaptureSession(plan as never);
    const lastCommitIdx = order.lastIndexOf('commit');
    const releaseIdx = order.lastIndexOf('release');
    expect(lastCommitIdx).toBeGreaterThanOrEqual(0);
    expect(releaseIdx).toBeGreaterThan(lastCommitIdx); // release 가 마지막 commit 이후
  });

  it('(14b) 부분 commit 실패 → rollback: release 인덱스 > 마지막 rollbackCred(write) 인덱스 (MAJOR-2)', async () => {
    // 2-cred: 첫 commit 성공(committed 기록) → 둘째 commit 실패 → 첫 cred 역순 rollback 발생.
    const order: string[] = [];
    const releaseSpy = vi.fn(async () => { order.push('release'); });
    mockAcquireRecapture.mockResolvedValue(releaseSpy);
    // backup-read + rollback 의 compare-and-restore current 가 모두 'NEW-1' 이어야 첫 cred 원복.
    mockReadProfile.mockResolvedValue('NEW-1');
    mockWriteProfile.mockImplementation(async () => { order.push('rollback-write'); });
    let commitCalls = 0;
    mockCommit.mockImplementation(async () => {
      order.push('commit');
      commitCalls += 1;
      if (commitCalls >= 2) throw new Error('두번째 commit 실패 주입'); // 둘째에서만 실패
    });
    const plan = await makePlanWith2Creds('NEW-1', 'NEW-2');
    await expect(recaptureSession(plan as never)).rejects.toThrow(/두번째 commit 실패/);
    const lastRollbackIdx = order.lastIndexOf('rollback-write');
    const releaseIdx = order.lastIndexOf('release');
    expect(lastRollbackIdx).toBeGreaterThanOrEqual(0); // 첫 cred rollback 이 실제 발생
    expect(releaseIdx).toBeGreaterThan(lastRollbackIdx); // release 가 마지막 rollback 이후
  });
});
