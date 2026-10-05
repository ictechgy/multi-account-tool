/** 영어 메시지 — `sessionCli` 영역. 키 구조가 기준 스키마이며 ko/sessionCli.ts 가 같은 키를 가져야 한다. */
export const sessionCli = {
  usage:
    `Usage:\n` +
    `  mat session start <cli> <profile>   Start an isolated subshell\n` +
    `  mat session run <cli> <profile> -- [cli-args...]\n` +
    `                                        Run a builtin CLI in an isolated env\n` +
    `  mat session run <cli> <profile> --check|--explain [--json] -- [cli-args...]\n` +
    `                                        Preflight check for session run without spawning\n` +
    `  mat session list [--json]           List sessions\n` +
    `  mat session stop <id>               Stop and clean up a session\n`,
  unknownSubcommand: (sub: string | undefined) => `mat session: unknown subcommand: ${sub ?? '(none)'}`,
  unknownOption: (sub: string, arg: string) => `mat session ${sub}: unknown option: ${arg}`,
  needCliAndProfile: (sub: string, count: number) =>
    `mat session ${sub}: requires two arguments, <cli> and <profile> (got ${count}).`,
  startExample: '  e.g. mat session start codex work',
  runExample: '  e.g. mat session run codex work -- --help',
  runMissingSeparator: 'mat session run: the command separator `--` is required.',
  runJsonRequiresCheck: 'mat session run: use --json together with --check or --explain.',
  noRunningSessions: 'No running sessions.',
  stopNeedsId: 'mat session stop: requires one argument, <id>.'
};
