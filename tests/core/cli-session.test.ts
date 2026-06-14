/**
 * PR-S4: handleSession (mat session 디스패치) 단위 테스트.
 *
 * handleSession 은 process.exit 를 호출하지 않고 종료코드를 반환 (M4). session.js 의
 * runSession/listSessions/stopSession 을 mock 해 디스패치/종료코드 규약만 검증한다.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/session.js', () => ({
  formatSessionRunPreflightReport: vi.fn(),
  runSession: vi.fn(),
  runSessionCommand: vi.fn(),
  preflightSessionRunCommand: vi.fn(),
  listSessions: vi.fn(),
  stopSession: vi.fn()
}));

import { handleSession } from '../../src/core/session-cli.js';
import {
  formatSessionRunPreflightReport,
  listSessions,
  preflightSessionRunCommand,
  runSession,
  runSessionCommand,
  stopSession
} from '../../src/core/session.js';

const mockFormatPreflight = vi.mocked(formatSessionRunPreflightReport);
const mockRun = vi.mocked(runSession);
const mockRunCommand = vi.mocked(runSessionCommand);
const mockPreflight = vi.mocked(preflightSessionRunCommand);
const mockList = vi.mocked(listSessions);
const mockStop = vi.mocked(stopSession);

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('handleSession — start', () => {
  it('정상 종료(code 0) → exitCode 0, runSession 호출', async () => {
    mockRun.mockResolvedValue({ code: 0, signal: null });
    const r = await handleSession(['start', 'codex', 'work']);
    expect(r).toEqual({ exitCode: 0 });
    expect(mockRun).toHaveBeenCalledWith({ cliId: 'codex', profileName: 'work' });
  });

  it('자식 non-zero 종료 → 그 code 전파', async () => {
    mockRun.mockResolvedValue({ code: 3, signal: null });
    expect(await handleSession(['start', 'codex', 'work'])).toEqual({ exitCode: 3 });
  });

  it('시그널 종료 → raiseSignal 채움 (self-raise)', async () => {
    mockRun.mockResolvedValue({ code: null, signal: 'SIGINT' });
    expect(await handleSession(['start', 'codex', 'work'])).toEqual({
      exitCode: 0,
      raiseSignal: 'SIGINT'
    });
  });

  it('재캡처 실패 → exitCode 74', async () => {
    mockRun.mockResolvedValue({ code: 0, signal: null, recaptureError: new Error('x') });
    expect(await handleSession(['start', 'codex', 'work'])).toEqual({ exitCode: 74 });
  });

  it('인자 부족(1개) → exitCode 2, runSession 미호출', async () => {
    expect(await handleSession(['start', 'codex'])).toEqual({ exitCode: 2 });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('인자 과다(3개) → exitCode 2', async () => {
    expect(await handleSession(['start', 'codex', 'work', 'extra'])).toEqual({ exitCode: 2 });
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('handleSession — run', () => {
  it('정상 종료(code 0) → exitCode 0, runSessionCommand 호출(argv 전달)', async () => {
    mockRunCommand.mockResolvedValue({ code: 0, signal: null });
    const r = await handleSession(['run', 'codex', 'work', '--', '--help']);
    expect(r).toEqual({ exitCode: 0 });
    expect(mockRunCommand).toHaveBeenCalledWith({
      cliId: 'codex',
      profileName: 'work',
      args: ['--help']
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('빈 argv 도 허용 (`--` 뒤 인자 없음)', async () => {
    mockRunCommand.mockResolvedValue({ code: 0, signal: null });
    expect(await handleSession(['run', 'codex', 'work', '--'])).toEqual({ exitCode: 0 });
    expect(mockRunCommand).toHaveBeenCalledWith({
      cliId: 'codex',
      profileName: 'work',
      args: []
    });
  });

  it('자식 non-zero 종료 → 그 code 전파', async () => {
    mockRunCommand.mockResolvedValue({ code: 7, signal: null });
    expect(await handleSession(['run', 'codex', 'work', '--', 'run'])).toEqual({ exitCode: 7 });
  });

  it('시그널 종료 → raiseSignal 채움 (self-raise)', async () => {
    mockRunCommand.mockResolvedValue({ code: null, signal: 'SIGTERM' });
    expect(await handleSession(['run', 'codex', 'work', '--'])).toEqual({
      exitCode: 0,
      raiseSignal: 'SIGTERM'
    });
  });

  it('재캡처 실패 → exitCode 74', async () => {
    mockRunCommand.mockResolvedValue({ code: 0, signal: null, recaptureError: new Error('x') });
    expect(await handleSession(['run', 'codex', 'work', '--'])).toEqual({ exitCode: 74 });
  });

  it('구분자 누락 → exitCode 2, runSessionCommand 미호출', async () => {
    expect(await handleSession(['run', 'codex', 'work'])).toEqual({ exitCode: 2 });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('구분자 전 인자 과다 → exitCode 2, runSessionCommand 미호출', async () => {
    expect(await handleSession(['run', 'codex', 'work', 'extra', '--'])).toEqual({ exitCode: 2 });
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('--check 성공 → preflight report 출력, exitCode 0, spawn 경로 미호출', async () => {
    const report = {
      schemaVersion: 1 as const,
      cliId: 'codex',
      profileName: 'work',
      args: ['--help'],
      ok: true,
      supported: true,
      profileExists: true,
      executable: 'codex',
      blockers: [],
      warnings: [],
      phases: [{ id: 'preflight', status: 'ok' as const }]
    };
    mockPreflight.mockResolvedValue(report);
    mockFormatPreflight.mockReturnValue('session run preflight: ok (codex/work)\n');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(await handleSession(['run', 'codex', 'work', '--check', '--', '--help'])).toEqual({ exitCode: 0 });

    expect(mockPreflight).toHaveBeenCalledWith({ cliId: 'codex', profileName: 'work', args: ['--help'] });
    expect(mockFormatPreflight).toHaveBeenCalledWith(report);
    expect(writeSpy).toHaveBeenCalledWith('session run preflight: ok (codex/work)\n');
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('--explain 차단 → preflight report 출력, exitCode 1', async () => {
    const report = {
      schemaVersion: 1 as const,
      cliId: 'opencode',
      profileName: 'work',
      args: ['run'],
      ok: false,
      supported: true,
      profileExists: null,
      blockers: [{ phase: 'opencode-preflight', code: 'session-run-hard-stop', message: 'blocked' }],
      warnings: [],
      phases: [{ id: 'opencode-preflight', status: 'blocked' as const }]
    };
    mockPreflight.mockResolvedValue(report);
    mockFormatPreflight.mockReturnValue('session run preflight: blocked (opencode/work)\n');
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(await handleSession(['run', 'opencode', 'work', '--explain', '--', 'run'])).toEqual({ exitCode: 1 });

    expect(mockPreflight).toHaveBeenCalledWith({ cliId: 'opencode', profileName: 'work', args: ['run'] });
    expect(writeSpy).toHaveBeenCalledWith('session run preflight: blocked (opencode/work)\n');
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('--check --json → JSON report 출력, formatter/spawn 경로 미호출', async () => {
    const report = {
      schemaVersion: 1 as const,
      cliId: 'aider',
      profileName: 'work',
      args: [],
      ok: false,
      supported: true,
      profileExists: true,
      blockers: [{ phase: 'aider-profile', code: 'aider-profile-hard-stop', message: 'profile blocked' }],
      warnings: [],
      phases: [{ id: 'aider-profile', status: 'blocked' as const }]
    };
    mockPreflight.mockResolvedValue(report);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);

    expect(await handleSession(['run', 'aider', 'work', '--check', '--json', '--'])).toEqual({ exitCode: 1 });

    const payload = String(writeSpy.mock.calls[0][0]);
    expect(JSON.parse(payload)).toEqual(report);
    expect(mockFormatPreflight).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('--json 단독 사용 → exitCode 2, preflight/run 미호출', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(await handleSession(['run', 'codex', 'work', '--json', '--'])).toEqual({ exitCode: 2 });

    expect(String(errSpy.mock.calls[0][0])).toContain('--json 은 --check 또는 --explain');
    expect(mockPreflight).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });

  it('구분자 전 알 수 없는 옵션 → exitCode 2, preflight/run 미호출', async () => {
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    expect(await handleSession(['run', 'codex', 'work', '--bad', '--'])).toEqual({ exitCode: 2 });

    expect(String(errSpy.mock.calls[0][0])).toContain('알 수 없는 옵션: --bad');
    expect(mockPreflight).not.toHaveBeenCalled();
    expect(mockRunCommand).not.toHaveBeenCalled();
  });
});

describe('handleSession — list', () => {
  it('빈 목록 → exitCode 0', async () => {
    mockList.mockResolvedValue([]);
    expect(await handleSession(['list'])).toEqual({ exitCode: 0 });
  });

  it('세션 있으면 테이블 출력 + exitCode 0', async () => {
    mockList.mockResolvedValue([
      { id: 'codex-work-aaaa', cli: 'codex', profile: 'work', pid: 1, startedAt: 'T', alive: true }
    ]);
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const r = await handleSession(['list']);
    expect(r).toEqual({ exitCode: 0 });
    expect(writeSpy.mock.calls.some((c) => String(c[0]).includes('codex-work-aaaa'))).toBe(true);
    writeSpy.mockRestore();
  });
});

describe('handleSession — stop', () => {
  it('정상 → stopSession 호출 + exitCode 0', async () => {
    mockStop.mockResolvedValue(undefined);
    expect(await handleSession(['stop', 'codex-work-aaaa'])).toEqual({ exitCode: 0 });
    expect(mockStop).toHaveBeenCalledWith('codex-work-aaaa');
  });

  it('인자 부족 → exitCode 2, stopSession 미호출', async () => {
    expect(await handleSession(['stop'])).toEqual({ exitCode: 2 });
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe('handleSession — 알 수 없는 서브커맨드', () => {
  it('bogus → exitCode 2', async () => {
    expect(await handleSession(['bogus'])).toEqual({ exitCode: 2 });
  });

  it('서브커맨드 없음 → exitCode 2', async () => {
    expect(await handleSession([])).toEqual({ exitCode: 2 });
  });
});
