/**
 * `mat session <start|list|stop>` CLI 핸들러.
 *
 * cli.tsx 의 bin 진입점은 import 시 main() 이 자동 실행되므로, 단위 테스트 가능하도록
 * 세션 디스패치 로직을 본 모듈로 분리한다 (M4). `handleSession` 은 **process.exit 를
 * 직접 호출하지 않고 종료코드를 반환**하며, exit/self-raise 는 호출부(cli.tsx main)가 한다.
 *
 * 종료코드 규약은 cli.tsx 의 handleExec 와 동형:
 *  - signal 종료 → `raiseSignal` 채움(호출부 self-raise, exitCode 무시)
 *  - 재캡처 실패(recaptureError) → 74 (EXIT_RECAPTURE_FAILED)
 *  - 그 외 → 자식 종료코드 전파 (정상 0)
 * 미지원/알 수 없는 CLI·프로필 부재는 runSession 이 UsageError throw → cli.tsx top-level
 * catch 가 exit 2 매핑. 잘못된 서브커맨드/인자는 여기서 exit 2 를 반환한다.
 */

import {
  formatSessionRunPreflightReport,
  listSessions,
  preflightSessionRunCommand,
  runSession,
  runSessionCommand,
  stopSession
} from './session.js';

/** 재캡처 실패 시 exit code (cli.tsx EXIT_RESTORE_FAILED 와 동일 74 — 자동화 감지용). */
const EXIT_RECAPTURE_FAILED = 74;

export const SESSION_USAGE =
  `사용법:\n` +
  `  mat session start <cli> <profile>   격리된 subshell 실행\n` +
  `  mat session run <cli> <profile> -- [cli-args...]\n` +
  `                                        builtin CLI 를 격리 env 로 직접 실행\n` +
  `  mat session run <cli> <profile> --check [--json] -- [cli-args...]\n` +
  `                                        spawn 없는 session run 사전 점검\n` +
  `  mat session list                    세션 목록\n` +
  `  mat session stop <id>               세션 종료/정리\n`;

export interface SessionDispatchResult {
  exitCode: number;
  raiseSignal?: NodeJS.Signals;
}

export async function handleSession(rest: string[]): Promise<SessionDispatchResult> {
  const [sub, ...subArgs] = rest;

  if (sub === 'start') {
    if (subArgs.length !== 2) {
      process.stderr.write(
        `mat session start: <cli> 와 <profile> 두 인자가 필요합니다 (받음: ${subArgs.length}개).\n` +
          `  예: mat session start codex work\n`
      );
      return { exitCode: 2 };
    }
    const [cliId, profileName] = subArgs;
    const { code, signal, recaptureError } = await runSession({ cliId, profileName });
    if (signal) return { exitCode: 0, raiseSignal: signal };
    if (code != null && code !== 0) return { exitCode: code };
    return { exitCode: recaptureError ? EXIT_RECAPTURE_FAILED : (code ?? 0) };
  }

  if (sub === 'run') {
    const parsed = parseSessionRunArgs(subArgs);
    if (!parsed.ok) {
      process.stderr.write(
        `${parsed.error}\n` +
        `  예: mat session run codex work -- --help\n`
      );
      return { exitCode: 2 };
    }
    if (!parsed.check && parsed.asJson) {
      process.stderr.write(`mat session run: --json 은 --check 또는 --explain 과 함께 사용하세요.\n`);
      return { exitCode: 2 };
    }
    if (parsed.check) {
      const report = await preflightSessionRunCommand({
        cliId: parsed.cliId,
        profileName: parsed.profileName,
        args: parsed.args
      });
      if (parsed.asJson) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(formatSessionRunPreflightReport(report));
      }
      return { exitCode: report.ok ? 0 : 1 };
    }
    const { code, signal, recaptureError } = await runSessionCommand({
      cliId: parsed.cliId,
      profileName: parsed.profileName,
      args: parsed.args
    });
    if (signal) return { exitCode: 0, raiseSignal: signal };
    if (code != null && code !== 0) return { exitCode: code };
    return { exitCode: recaptureError ? EXIT_RECAPTURE_FAILED : (code ?? 0) };
  }

  if (sub === 'list') {
    const sessions = await listSessions();
    if (sessions.length === 0) {
      process.stdout.write('실행 중인 세션이 없습니다.\n');
      return { exitCode: 0 };
    }
    process.stdout.write('ID\tCLI\tPROFILE\tSTARTED\tSTATUS\n');
    for (const s of sessions) {
      process.stdout.write(
        `${s.id}\t${s.cli}\t${s.profile}\t${s.startedAt}\t${s.alive ? 'active' : 'orphan'}\n`
      );
    }
    return { exitCode: 0 };
  }

  if (sub === 'stop') {
    if (subArgs.length !== 1) {
      process.stderr.write(`mat session stop: <id> 한 인자가 필요합니다.\n`);
      return { exitCode: 2 };
    }
    await stopSession(subArgs[0]);
    return { exitCode: 0 };
  }

  process.stderr.write(`mat session: 알 수 없는 서브커맨드: ${sub ?? '(없음)'}\n${SESSION_USAGE}`);
  return { exitCode: 2 };
}

interface ParsedSessionRunArgs {
  ok: true;
  cliId: string;
  profileName: string;
  args: string[];
  check: boolean;
  asJson: boolean;
}

interface SessionRunArgError {
  ok: false;
  error: string;
}

function parseSessionRunArgs(subArgs: string[]): ParsedSessionRunArgs | SessionRunArgError {
  const sepIdx = subArgs.indexOf('--');
  if (sepIdx < 0) {
    return { ok: false, error: 'mat session run: 명령 구분자 `--` 가 필요합니다.' };
  }
  const rawBefore = subArgs.slice(0, sepIdx);
  const args = subArgs.slice(sepIdx + 1);
  let check = false;
  let asJson = false;
  const before: string[] = [];
  for (const arg of rawBefore) {
    if (arg === '--check' || arg === '--explain') {
      check = true;
      continue;
    }
    if (arg === '--json') {
      asJson = true;
      continue;
    }
    if (arg.startsWith('-')) {
      return { ok: false, error: `mat session run: 알 수 없는 옵션: ${arg}` };
    }
    before.push(arg);
  }
  if (before.length !== 2) {
    return { ok: false, error: `mat session run: <cli> 와 <profile> 두 인자가 필요합니다 (받음: ${before.length}개).` };
  }
  const [cliId, profileName] = before;
  return { ok: true, cliId, profileName, args, check, asJson };
}
