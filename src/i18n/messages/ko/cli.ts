import type { Messages } from '../en.js';

/** 한국어 메시지 — `cli` 영역. */
export const cli: Messages['cli'] = {
  usage:
    `사용법:\n` +
    `  mat                                            TUI 실행\n` +
    `  mat exec <cli> <profile> -- <cmd...>          <profile> 로 swap 후 <cmd> 실행, 종료 후 원복\n` +
    `  mat session start <cli> <profile>             <profile> 로 격리된 subshell 실행 (동시 다계정)\n` +
    `  mat session run <cli> <profile> -- [args...]  builtin CLI 를 격리 env 로 직접 실행\n` +
    `  mat session run <cli> <profile> --check|--explain [--json] -- [args...]\n` +
    `                                                 spawn 없는 session run 사전 점검\n` +
    `  mat session list [--json]                     실행 중/orphan 세션 목록\n` +
    `  mat session stop <id>                         세션 종료 또는 orphan 정리\n` +
    `  mat status [--json]                           active profile/session 상태 요약\n` +
    `  mat plugin validate [path] [--json]           plugin JSON 정적 검증/린트\n` +
    `  mat plugin scaffold <id> [--json]             starter plugin JSON 출력 (파일 미작성)\n` +
    `  mat freshness [<cli>] [--profile <name>] [--json] [--check-only]\n` +
    `                                                 라이브 vs 활성 프로필 자격증명 비교 (OAuth\n` +
    `                                                 refresh rotation 안전성 점검). cli 미지정 시\n` +
    `                                                 모든 builtin/plugin CLI 보고. --check-only 면\n` +
    `                                                 stale 감지해도 exit 0 (read-only 모니터링).\n` +
    `  mat doctor [--json]                           read-only 안전 진단 (자격증명 값 미열람)\n` +
    `  mat support <cli> [--json]                    CLI 지원 범위/한계/계약 설명\n` +
    `  mat explain <cli> [--json]                    support 의 alias\n` +
    `  mat config language [en|ko|--unset]           표시 언어 확인/저장 (첫 TUI 실행 때도 선택)\n` +
    `  mat --help                                     이 도움말 출력\n` +
    `  mat --version                                  버전 출력\n` +
    `  mat --lang <en|ko> [command...]               표시 언어 지정. MAT_LANG 환경변수 또는\n` +
    `                                                 config.json 의 "language" 로도 설정 가능\n`,
  unknownCommand: (command: string) => `mat: 알 수 없는 명령: ${command}`,
  unknownOption: (command: string, option: string) => `mat ${command}: 알 수 없는 옵션: ${option}`,

  status: {
    help:
      `사용법:\n` +
      `  mat status [--json]\n` +
      `\n` +
      `active profile 포인터와 session lifecycle 요약을 read-only 로 출력합니다.\n`
  },

  plugin: {
    help:
      `사용법:\n` +
      `  mat plugin validate [path] [--json]\n` +
      `  mat plugin scaffold <id> [--json]\n` +
      `\n` +
      `사용자 plugin JSON 을 정적으로 검증합니다. validate 는 credential 파일이나\n` +
      `keyring secret 값을 읽지 않습니다. path 를 생략하면 설치된\n` +
      `~/.multi-account-tool/cli-defs/*.json 을 검사합니다.\n` +
      `scaffold 는 starter JSON 을 stdout 으로만 출력하며 파일을 쓰지 않습니다.\n`,
    unknownSubcommand: (subcommand: string) => `mat plugin: 알 수 없는 하위 명령: ${subcommand}`,
    validateHelp:
      `사용법:\n` +
      `  mat plugin validate [path] [--json]\n` +
      `\n` +
      `path 를 지정하면 해당 JSON 파일만 검사하고, 생략하면 설치된\n` +
      `~/.multi-account-tool/cli-defs/*.json 전체를 검사합니다.\n` +
      `exit 0: error 없음, exit 1: validation/read/parse error, exit 2: 사용법 오류.\n`,
    validateSinglePath: 'mat plugin validate: path 는 하나만 지정할 수 있습니다.',
    scaffoldHelp:
      `사용법:\n` +
      `  mat plugin scaffold <id> [--json]\n` +
      `\n` +
      `starter plugin JSON 을 stdout 으로 출력합니다. 파일은 쓰지 않습니다.\n`,
    scaffoldBuiltinId: (id: string) =>
      `mat plugin scaffold: '${id}' 는 builtin CLI id 라서 plugin 으로 사용할 수 없습니다.`,
    scaffoldSingleId: 'mat plugin scaffold: <id> 는 하나만 지정할 수 있습니다.',
    scaffoldIdRequired: 'mat plugin scaffold: <id> 인자가 필요합니다.',
    reportNoFiles: '(검사할 plugin JSON 없음)',
    reportNote: '참고: 이 검사는 정적 검증이며 credential 파일/keyring secret 값은 읽지 않습니다.'
  },

  doctor: {
    help:
      `사용법:\n` +
      `  mat doctor [--json]\n` +
      `\n` +
      `read-only 안전 진단을 실행합니다. 자격증명 값/Keychain secret 값은 읽지 않고,\n` +
      `active profile, source 존재 여부, ambient env/project config 우회 가능성,\n` +
      `session 지원 상태를 보고합니다. OAuth deep 비교는 명시적으로 mat freshness 를 사용하세요.\n`
  },

  support: {
    help:
      `사용법:\n` +
      `  mat support <cli> [--json]\n` +
      `  mat explain <cli> [--json]\n` +
      `\n` +
      `CLI 별 mat 지원 범위와 한계를 설명합니다. swap, freshness, session start/run,\n` +
      `ambient/project override 위험, 마지막으로 확인한 upstream 계약을 보여줍니다.\n`,
    singleCli: (command: string) => `mat ${command}: <cli> 는 하나만 지정할 수 있습니다.`,
    cliRequired: (command: string) => `mat ${command}: <cli> 인자가 필요합니다.`
  },

  exec: {
    separatorRequired: 'mat exec: 명령 구분자 `--` 가 필요합니다.',
    twoArgsRequired: (count: number) => `mat exec: <cli> 와 <profile> 두 인자가 필요합니다 (받음: ${count}개).`,
    example: '  예: mat exec claude work -- claude --help',
    emptyCommand: 'mat exec: 실행할 명령이 비어 있습니다. `--` 뒤에 명령을 지정하세요.'
  },

  freshness: {
    profileValueRequired: 'mat freshness: --profile 에 값이 필요합니다.',
    tooManyArgs: (arg: string) => `mat freshness: 인자 과다 (예상 1 cli, 실제 2+): ${arg}`,
    noActiveProfile: (cliId: string) =>
      `mat freshness ${cliId}: active profile 미설정. --profile <name> 으로 지정하세요.`,
    noReports: '(보고할 CLI 없음 — active profile 미설정. mat TUI 로 capture 후 재실행하세요.)',
    emptySources: '(모든 CLI 의 source 정의가 비어있음 — cli-defs 점검 필요)'
  }
};
