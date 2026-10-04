/** 영어 메시지 — `cli` 영역. 키 구조가 기준 스키마이며 ko/cli.ts 가 같은 키를 가져야 한다. */
export const cli = {
  usage:
    `Usage:\n` +
    `  mat                                            Launch the TUI\n` +
    `  mat exec <cli> <profile> -- <cmd...>          Swap to <profile>, run <cmd>, then restore\n` +
    `  mat session start <cli> <profile>             Start an isolated subshell as <profile>\n` +
    `                                                 (concurrent multi-account)\n` +
    `  mat session run <cli> <profile> -- [args...]  Run a builtin CLI in an isolated env\n` +
    `  mat session run <cli> <profile> --check|--explain [--json] -- [args...]\n` +
    `                                                 Preflight check for session run (no spawn)\n` +
    `  mat session list [--json]                     List running/orphan sessions\n` +
    `  mat session stop <id>                         Stop a session or clean up an orphan\n` +
    `  mat status [--json]                           Summarize active profile/session state\n` +
    `  mat plugin validate [path] [--json]           Statically validate/lint plugin JSON\n` +
    `  mat plugin scaffold <id> [--json]             Print starter plugin JSON (writes no file)\n` +
    `  mat freshness [<cli>] [--profile <name>] [--json] [--check-only]\n` +
    `                                                 Compare live vs active profile credentials\n` +
    `                                                 (OAuth refresh rotation safety check). Without\n` +
    `                                                 a cli, reports every builtin/plugin CLI. With\n` +
    `                                                 --check-only, exits 0 even when stale is\n` +
    `                                                 detected (read-only monitoring).\n` +
    `  mat doctor [--json]                           Read-only safety diagnostics (never reads\n` +
    `                                                 credential values)\n` +
    `  mat support <cli> [--json]                    Explain CLI support scope/limits/contracts\n` +
    `  mat explain <cli> [--json]                    Alias of support\n` +
    `  mat config language [en|ko|--unset]           Show/save display language (also asked on\n` +
    `                                                 first TUI launch)\n` +
    `  mat --help                                     Print this help\n` +
    `  mat --version                                  Print the version\n` +
    `  mat --lang <en|ko> [command...]               Set the display language (also settable via\n` +
    `                                                 MAT_LANG or "language" in config.json)\n`,
  unknownCommand: (command: string) => `mat: unknown command: ${command}`,
  unknownOption: (command: string, option: string) => `mat ${command}: unknown option: ${option}`,

  status: {
    help:
      `Usage:\n` +
      `  mat status [--json]\n` +
      `\n` +
      `Prints a read-only summary of the active profile pointer and session lifecycle.\n`
  },

  plugin: {
    help:
      `Usage:\n` +
      `  mat plugin validate [path] [--json]\n` +
      `  mat plugin scaffold <id> [--json]\n` +
      `\n` +
      `Statically validates user plugin JSON. validate does not read credential files\n` +
      `or keyring secret values. If path is omitted, it checks the installed\n` +
      `~/.multi-account-tool/cli-defs/*.json.\n` +
      `scaffold only prints starter JSON to stdout and writes no files.\n`,
    unknownSubcommand: (subcommand: string) => `mat plugin: unknown subcommand: ${subcommand}`,
    validateHelp:
      `Usage:\n` +
      `  mat plugin validate [path] [--json]\n` +
      `\n` +
      `With a path, checks only that JSON file; without one, checks all installed\n` +
      `~/.multi-account-tool/cli-defs/*.json.\n` +
      `exit 0: no errors, exit 1: validation/read/parse error, exit 2: usage error.\n`,
    validateSinglePath: 'mat plugin validate: only one path can be specified.',
    scaffoldHelp:
      `Usage:\n` +
      `  mat plugin scaffold <id> [--json]\n` +
      `\n` +
      `Prints starter plugin JSON to stdout. Writes no files.\n`,
    scaffoldBuiltinId: (id: string) =>
      `mat plugin scaffold: '${id}' is a builtin CLI id and cannot be used as a plugin.`,
    scaffoldSingleId: 'mat plugin scaffold: only one <id> can be specified.',
    scaffoldIdRequired: 'mat plugin scaffold: <id> argument is required.',
    reportNoFiles: '(no plugin JSON to check)',
    reportNote: 'Note: static check only; credential files and keyring secret values are not read.'
  },

  doctor: {
    help:
      `Usage:\n` +
      `  mat doctor [--json]\n` +
      `\n` +
      `Runs read-only safety diagnostics. Credential values and Keychain secret values are\n` +
      `not read. Reports the active profile, whether sources exist, possible ambient\n` +
      `env/project config bypasses, and session support status. For a deep OAuth\n` +
      `comparison, use mat freshness explicitly.\n`
  },

  support: {
    help:
      `Usage:\n` +
      `  mat support <cli> [--json]\n` +
      `  mat explain <cli> [--json]\n` +
      `\n` +
      `Explains mat's support scope and limits for a CLI: swap, freshness, session start/run,\n` +
      `ambient/project override risks, and the last verified upstream contract.\n`,
    singleCli: (command: string) => `mat ${command}: only one <cli> can be specified.`,
    cliRequired: (command: string) => `mat ${command}: <cli> argument is required.`
  },

  exec: {
    separatorRequired: 'mat exec: the command separator `--` is required.',
    twoArgsRequired: (count: number) =>
      `mat exec: two arguments, <cli> and <profile>, are required (got ${count}).`,
    example: '  e.g. mat exec claude work -- claude --help',
    emptyCommand: 'mat exec: the command to run is empty. Specify a command after `--`.'
  },

  freshness: {
    profileValueRequired: 'mat freshness: --profile requires a value.',
    tooManyArgs: (arg: string) => `mat freshness: too many arguments (expected 1 cli, got 2+): ${arg}`,
    noActiveProfile: (cliId: string) =>
      `mat freshness ${cliId}: no active profile set. Specify one with --profile <name>.`,
    noReports: '(nothing to report — no active profile set. Capture one in the mat TUI, then rerun.)',
    emptySources: '(source definitions are empty for every CLI — check cli-defs)'
  }
};
