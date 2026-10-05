import type { Messages } from '../en.js';

/** 한국어 메시지 — `sessionCli` 영역. */
export const sessionCli: Messages['sessionCli'] = {
  usage:
    `사용법:\n` +
    `  mat session start <cli> <profile>   격리된 subshell 실행\n` +
    `  mat session run <cli> <profile> -- [cli-args...]\n` +
    `                                        builtin CLI 를 격리 env 로 직접 실행\n` +
    `  mat session run <cli> <profile> --check|--explain [--json] -- [cli-args...]\n` +
    `                                        spawn 없는 session run 사전 점검\n` +
    `  mat session list [--json]           세션 목록\n` +
    `  mat session stop <id>               세션 종료/정리\n`,
  unknownSubcommand: (sub) => `mat session: 알 수 없는 서브커맨드: ${sub ?? '(없음)'}`,
  unknownOption: (sub, arg) => `mat session ${sub}: 알 수 없는 옵션: ${arg}`,
  needCliAndProfile: (sub, count) =>
    `mat session ${sub}: <cli> 와 <profile> 두 인자가 필요합니다 (받음: ${count}개).`,
  startExample: '  예: mat session start codex work',
  runExample: '  예: mat session run codex work -- --help',
  runMissingSeparator: 'mat session run: 명령 구분자 `--` 가 필요합니다.',
  runJsonRequiresCheck: 'mat session run: --json 은 --check 또는 --explain 과 함께 사용하세요.',
  noRunningSessions: '실행 중인 세션이 없습니다.',
  stopNeedsId: 'mat session stop: <id> 한 인자가 필요합니다.'
};
