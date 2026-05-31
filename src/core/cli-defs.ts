/**
 * 내장 AI CLI 정의 목록 + 사용자 plugin 통합.
 *
 * 새 CLI 추가는 두 가지 방법:
 *  1. **builtin** — BUILTIN_CLI_DEFS 에 항목 추가 (mat repo 수정 + 재배포)
 *  2. **plugin** — `~/.multi-account-tool/cli-defs/<id>.json` 파일 추가
 *     (mat 코드 수정 없이, 사용자가 직접 관리)
 *
 * findCliDef / getAllCliDefs 는 두 출처를 모두 검색한다. 동일 id 가 builtin 과
 * plugin 양쪽에 있으면 **builtin 이 우선** (보안 — 사용자가 builtin 을 의도치 않게
 * 덮어쓰는 사고 방지). plugin 끼리 충돌 시는 첫 등장 우선 (loadUserCliDefs 가 정렬 후 처리).
 *
 * plugin 은 startup 시점 sync 로딩 후 module-level 캐시. 변경 사항 적용은
 * 새 mat 인스턴스 (또는 테스트에서 resetCliDefCache 호출) 필요.
 */

import { loadUserCliDefs } from './cli-defs-plugin.js';
import type { CliDef, Source } from './types.js';

/**
 * Claude Code 의 자격증명 source.
 * macOS 에서는 Keychain (`Claude Code-credentials`) 에,
 * 그 외 OS 에서는 `~/.claude/.credentials.json` 파일에 저장된다.
 */
function claudeSource(): Source {
  if (process.platform === 'darwin') {
    return { type: 'keychain', service: 'Claude Code-credentials', saveAs: 'credentials.json' };
  }
  return { type: 'file', path: '~/.claude/.credentials.json', saveAs: 'credentials.json' };
}

/**
 * Goose (Block 의 오픈소스 AI agent — https://github.com/block/goose) 의 자격증명 source 들.
 *
 * Goose 의 credential 백엔드 (crates/goose/src/config/base.rs):
 *  - macOS: Keychain — `KEYRING_SERVICE = "goose"`, `KEYRING_USERNAME = "secrets"` (단일 entry).
 *    service 명이 generic 단어라 mat 의 `KeychainSource.service` 만으로는 wrong-entry 위험
 *    → PR-A 의 `account: 'secrets'` 명시로 `-s goose -a secrets` 항목 하나만 안전하게 swap.
 *  - Linux: 기본 `secret-service` 백엔드 (libsecret, GNOME Keyring/KWallet) — **PR-4 부터 지원**.
 *    mat 가 `os-keyring` source (secret-tool CLI) 로 `service=goose, account=secrets` 항목을
 *    swap 한다. `secret-service` 미사용 환경(GOOSE_DISABLE_KEYRING 등)에서는 부재 source 로
 *    자동 skip 되고 file fallback (`~/.config/goose/secrets.yaml`) 이 동작한다.
 *  - 모든 OS: 비-secret config (model/provider 라우팅 등) 는 `~/.config/goose/config.yaml` 평문.
 *
 * mat 의 swap 전략:
 *  - **macOS (기본 keyring)**: keychain (`account: secrets`) + `secrets.yaml` + `config.yaml`.
 *    `GOOSE_DISABLE_KEYRING` 존재 시엔 keychain 도 생략(yaml 만) — Linux 와 대칭으로 stale
 *    keychain swap(wrong-account)을 차단. keychain 과 yaml 두 backend 를 동시 사용하지 말 것
 *    (stale 위험).
 *  - **Linux (기본 keyring)**: os-keyring (`service=goose, account=secrets`, backend
 *    `secret-service`) + `secrets.yaml` + `config.yaml`. macOS 와 동형 (keychain → os-keyring
 *    만 교체). macOS 와 마찬가지로 os-keyring 과 yaml 두 backend 를 동시 사용하지 말 것
 *    (stale 위험). secret-tool (libsecret-tools) + keyring daemon 이 있어야 동작하며, 미설치/
 *    daemon-down 시 **명시 에러** (os-keyring.ts, fail-closed). entry 부재(exit 0+빈 출력)는
 *    정상 skip → yaml fallback.
 *  - **Linux/macOS (file backend)**: `GOOSE_DISABLE_KEYRING` 가 **존재하면**(값 무관,
 *    gooseUsesFileBackend) keyring source 를 **생략**하고 `secrets.yaml` + `config.yaml` 만
 *    swap. Goose 의 presence-only env 시맨틱에 맞춘 이유는 gooseUsesFileBackend 주석 참고 (#59).
 *  - **그 외 OS** (win32/freebsd 등): `secrets.yaml` + `config.yaml` 만. Windows Credential
 *    Manager 는 별도 후속 plan (PR-W).
 *
 * 한계 (README/ROADMAP 명시):
 *  - Linux 기본(keyring) 사용자는 secret-tool (libsecret-tools) + keyring daemon 이 필요하다.
 *    미설치/daemon-down 은 명시 에러로 안내 — file backend 면 `GOOSE_DISABLE_KEYRING=1` 로
 *    os-keyring 을 끄면 yaml 로 swap 된다.
 *  - shell env (`GOOSE_*`, provider 별 `OPENAI_API_KEY` 등) 는 mat scope 밖.
 *  - project-local override 도 mat scope 밖.
 */
/**
 * Goose 가 file backend(`secrets.yaml`) 를 쓰도록 강제됐는지 — Goose 와 **동일 시맨틱**으로 판정.
 *
 * `GOOSE_DISABLE_KEYRING` env 가 **존재하면**(값 무관 — `0`/`false`/빈 문자열 포함) file-backend
 * 로 보고 keyring source(os-keyring/keychain)를 생략한다. Goose 의 `base.rs` 가
 * `env::var("GOOSE_DISABLE_KEYRING").is_ok()` (presence-only) 로 판정하므로 정확히 맞춘다.
 * env 미설정이면 Goose 기본값인 keyring 으로 가정해 keyring source 를 포함한다.
 *
 * **왜 truthy 파싱이 아니라 presence-only 인가** (#59 quad-review HIGH, Goose 소스로 검증):
 * `1`/`true`/`yes` 만 file-backend 로 보면 `GOOSE_DISABLE_KEYRING=0` 같은 입력에서 Goose(=file
 * backend)와 어긋나, mat 이 keyring source 를 포함해 stale keyring 을 swap 하는 wrong-account
 * 사고가 난다. Goose 와 동일하게 존재 여부만 본다.
 *
 * **왜 secret-tool CLI 부재를 신호로 쓰지 않는가** (#59 quad-review HIGH 합의): Goose 는
 * libsecret **라이브러리**(`libsecret-1-0`) 로 keyring 에 접근하고, mat 는 별도 패키지인
 * `secret-tool` CLI(`libsecret-tools`) 로 읽는다. 둘은 독립 패키지라 secret-tool CLI 없이도
 * Goose 가 keyring 을 활성 사용할 수 있다. CLI 부재를 file-backend 로 오인해 os-keyring 을
 * skip 하면 활성 keyring 사용자가 stale `secrets.yaml` 로 swap 되는 wrong-account 사고가 난다.
 * 따라서 확실한 disable 신호가 없으면 os-keyring 을 포함하고, secret-tool 미설치는 부재로
 * 처리하지 않고 명시 에러(os-keyring.ts)로 안내한다.
 *
 * 한계: `~/.config/goose/config.yaml` 의 file-backend 설정은 자동 감지하지 않는다. 그 경우
 * `GOOSE_DISABLE_KEYRING=1` 을 함께 지정하거나, secret-tool 미설치 명시 에러 안내를 따른다.
 */
function gooseUsesFileBackend(): boolean {
  // Goose 와 동일하게 **presence-only** 판정 — base.rs 의
  // `env::var("GOOSE_DISABLE_KEYRING").is_ok()` 는 값과 무관하게 변수가 **존재하면**
  // file backend 다 (`0`/`false`/빈 문자열 포함). 따라서 truthy 파싱(`1/true/yes`)이 아니라
  // 존재 여부만 본다 — 값 기반 판정은 `GOOSE_DISABLE_KEYRING=0` 같은 입력에서 Goose 와
  // 어긋나 stale keyring 을 swap 하는 wrong-account 위험을 만든다 (#59 quad-review HIGH,
  // Goose 소스로 검증). config.yaml 의 keyring:false 설정은 자동 감지하지 않는다(한계).
  return process.env.GOOSE_DISABLE_KEYRING != null;
}

function gooseSources(): Source[] {
  const yamlSources: Source[] = [
    { type: 'file', path: '~/.config/goose/secrets.yaml', saveAs: 'goose-secrets.yaml' },
    { type: 'file', path: '~/.config/goose/config.yaml', saveAs: 'goose-config.yaml' }
  ];
  // file backend(GOOSE_DISABLE_KEYRING 존재) 면 macOS 도 keychain 을 생략한다 — Goose 가
  // file backend 일 때 stale keychain 항목을 swap 하는 wrong-account 위험 차단 (Linux 와 대칭).
  if (process.platform === 'darwin' && !gooseUsesFileBackend()) {
    return [
      { type: 'keychain', service: 'goose', account: 'secrets', saveAs: 'goose-keyring.json' },
      ...yamlSources
    ];
  }
  // Linux 는 Goose 의 기본 secret-service 백엔드를 os-keyring source 로 swap (PR-4).
  // macOS keychain 분기와 동형 — service/account/saveAs 동일, backend 만 secret-service 명시.
  // 단, file backend 가 확실할 때(GOOSE_DISABLE_KEYRING 존재)만 os-keyring 을 생략한다 (#59).
  if (process.platform === 'linux' && !gooseUsesFileBackend()) {
    return [
      {
        type: 'os-keyring',
        service: 'goose',
        account: 'secrets',
        backend: 'secret-service',
        saveAs: 'goose-keyring.json'
      },
      ...yamlSources
    ];
  }
  return yamlSources;
}


export const BUILTIN_CLI_DEFS: CliDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    sources: [claudeSource()]
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    sources: [
      { type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }
    ],
    // CODEX_HOME 으로 ~/.codex 전체 재배치 가능 (auth.json 포함). 세션 격리 지원.
    // config.toml 은 별도 파일이라 share 후보지만, OAuth state 포함 여부 미검증 →
    // 1차 share 비움(M-A, fail-closed). 검증 후 follow-up 으로 켠다.
    session: { roots: [{ env: 'CODEX_HOME', base: '~/.codex' }] }
  },
  {
    id: 'gemini',
    name: 'Gemini / Antigravity',
    sources: [
      { type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' },
      { type: 'file', path: '~/.gemini/google_accounts.json', saveAs: 'google_accounts.json' }
    ]
  },
  {
    // Aider 는 `~/.aider.conf.yml` 에 모델 + API key 를 텍스트로 보관 (env var 사용자는 별도 워크플로 필요).
    // 빌트인 추가 가치는 "기본 제공" 편의성 — plugin JSON 작성 없이 즉시 사용 가능.
    id: 'aider',
    name: 'Aider',
    sources: [
      { type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }
    ]
  },
  {
    // MoonshotAI 공식 Kimi Code CLI (https://github.com/MoonshotAI/kimi-cli).
    // 단일 TOML 파일 `~/.kimi/config.toml` 에 provider/api_key + OAuth 토큰 모두 평문 저장.
    // CLI 자체는 `--config-file <path>` 로 경로 override 가능하나 mat 의 swap 모델은 기본 경로 swap 으로 충분.
    id: 'kimi',
    name: 'Kimi CLI',
    sources: [
      { type: 'file', path: '~/.kimi/config.toml', saveAs: 'kimi.toml' }
    ],
    // KIMI_SHARE_DIR 로 ~/.kimi 재배치 가능 (config.toml 포함). 세션 격리 지원.
    // config.toml 이 자격증명=config 그 자체(A=B)라 share 후보 없음 — 통째 격리 복사.
    session: { roots: [{ env: 'KIMI_SHARE_DIR', base: '~/.kimi' }] }
  },
  {
    // Alibaba 공식 Qwen Code CLI (https://github.com/QwenLM/qwen-code, npm `@qwen-code/qwen-code`).
    // Gemini CLI 의 `~/.gemini/` 패턴을 차용 → `~/.qwen/settings.json` (provider/API key + 라우팅 설정).
    // OAuth 는 2026-04-15 종료 — 현재는 API key (DASHSCOPE/OpenAI/Anthropic 호환) 기반.
    //
    // credential 우선순위 (Qwen 공식 docs): shell export > `.env` > `~/.qwen/.env` > settings.json `env`.
    // mat 는 home 단위 source 두 개 (`settings.json` + `.env`) 를 함께 swap 한다 — 부재 source 는 skip
    // (Gemini multi-source 패턴 동일). shell export 와 프로젝트 로컬 `.env` 는 mat scope 밖이므로,
    // README 의 보안/사용 환경 안내에서 swap 적용 한계로 명시한다.
    // saveAs 에 `qwen-` prefix: ~/.qwen/ 하위 파일들이 mat profile 디렉토리에서도 식별 가능하게 유지.
    id: 'qwen',
    name: 'Qwen Code CLI',
    sources: [
      { type: 'file', path: '~/.qwen/settings.json', saveAs: 'qwen-settings.json' },
      { type: 'file', path: '~/.qwen/.env', saveAs: 'qwen.env' }
    ],
    // QWEN_HOME 으로 ~/.qwen 재배치 가능 (settings.json + .env 포함). 세션 격리 지원.
    // settings.json 이 자격증명+config 혼재라 share 후보 없음 — 통째 격리 복사.
    session: { roots: [{ env: 'QWEN_HOME', base: '~/.qwen' }] }
  },
  {
    // Charm.sh 공식 Crush (https://github.com/charmbracelet/crush). Go 기반 TUI AI 코딩 에이전트.
    // mat 의 home 단위 swap 대상 — XDG 표준 경로 (macOS/Linux 동일):
    //   - `~/.config/crush/crush.json` — 전역 설정 (읽기 우선)
    //   - `~/.local/share/crush/crush.json` — provider/API key 쓰기 대상
    // 두 파일을 함께 swap 해야 계정 전환이 일관 (단일만 swap 시 한쪽 데이터 stale).
    //
    // Crush 의 config lookup 우선순위 (`internal/config/load.go` 의 lookupConfigs):
    //   global (위 두 파일) → cwd 의 `.crush.json` / `crush.json` → workspace `.crush/crush.json` (마지막 우선).
    //   → **mat scope 밖** (mat 는 home 단위 swap 만 — cwd/workspace 단위는 사용자 책임):
    //     - cwd 의 `.crush.json` / `crush.json` (project-local, git root 까지 upward 탐색)
    //     - workspace `.crush/crush.json`
    //     - shell-exported provider env vars (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` 등)
    //     - Crush 의 path override env vars (`CRUSH_GLOBAL_CONFIG` / `CRUSH_GLOBAL_DATA` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME`) —
    //       사용자가 이들을 설정하면 mat 가 swap 한 기본 XDG 경로가 무시될 수 있음.
    //   사용자가 위 경로 중 하나를 활성 credential 으로 쓰고 있다면 mat swap 결과가 의도와 어긋날 수 있다.
    id: 'crush',
    name: 'Crush',
    sources: [
      { type: 'file', path: '~/.config/crush/crush.json', saveAs: 'crush-config.json' },
      { type: 'file', path: '~/.local/share/crush/crush.json', saveAs: 'crush-data.json' }
    ],
    // CRUSH_GLOBAL_CONFIG / CRUSH_GLOBAL_DATA 로 두 base 를 각각 재배치 가능. 세션 격리 지원.
    // data root(~/.local/share/crush) 의 비-secret 구조 미조사 → 1차 share 0(전부 ephemeral).
    session: {
      roots: [
        { env: 'CRUSH_GLOBAL_CONFIG', base: '~/.config/crush' },
        { env: 'CRUSH_GLOBAL_DATA', base: '~/.local/share/crush' }
      ]
    }
  },
  {
    // SST OpenCode (https://github.com/sst/opencode). MIT 라이선스 오픈소스 AI 코딩 에이전트.
    // credential 은 단일 JSON 파일 `auth.json`. 권한 0o600.
    // provider ID 마다 `{ type: 'api', key: ... }` 또는 OAuth 토큰 객체.
    //
    // 경로 — `packages/core/src/global.ts` 가 npm `xdg-basedir` 의 `xdgData` 를 사용:
    //   `${xdgData}/opencode/auth.json`. xdg-basedir 는 **OS 무관 XDG 표준** 만 따른다
    //   (Apple Application Support 등 native 경로 분기 없음) → macOS / Linux / BSD / Windows 모두
    //   기본값 `~/.local/share/opencode/auth.json`. (이전 조사가 etcetera Rust 패턴으로 macOS Apple
    //   base dir 분기를 가정했으나 npm xdg-basedir 동작과 다름 — PR #28 quad-review 정정 사항).
    //
    // mat scope 밖 한계 (PR #28 quad-review Codex HIGH 반영):
    //   - `XDG_DATA_HOME` env 가 설정되면 OpenCode 는 `$XDG_DATA_HOME/opencode/auth.json` 사용 →
    //     mat 의 기본 `~/.local/share` 경로 swap 무효 (wrong-account 위험, Crush PR #27 동일 카테고리).
    //   - `OPENCODE_AUTH_CONTENT` env 가 설정되면 OpenCode 가 파일 대신 env 내용 우선 사용.
    //   - `OPENCODE_CONFIG_DIR` env 로 디렉토리 자체 override 시 기본 경로 swap 무효.
    //   - `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 로 config 자체를 주입하면 별도 provider 라우팅 가능.
    //   - 프로젝트 로컬 `opencode.json` / `opencode.jsonc` / `.opencode/opencode.json` + 프로젝트 `.env` 도
    //     provider env 참조를 통해 credential 선택에 영향. (cwd 기반은 mat scope 밖)
    //   - config 내 `"apiKey": "{env:ANTHROPIC_API_KEY}"` env 참조 사용 시 shell env 가 실제 key 결정.
    id: 'opencode',
    name: 'OpenCode',
    sources: [
      { type: 'file', path: '~/.local/share/opencode/auth.json', saveAs: 'opencode-auth.json' }
    ]
  },
  {
    // Block 의 오픈소스 AI agent (https://github.com/block/goose).
    // PR-A 의 KeychainSource.account optional 필드를 사용하는 첫 builtin —
    // service `goose` 가 generic 단어라 account scope 가 필수 (wrong-entry 차단).
    // platform 분기 및 한계는 gooseSources() 의 JSDoc 참고.
    id: 'goose',
    name: 'Goose',
    sources: gooseSources()
  }
];

let cachedAllDefs: CliDef[] | null = null;
let cachedWarnings: string[] = [];

/**
 * builtin + plugin 통합 CLI 정의 목록. startup 시점에 1회 로드 후 캐시.
 * id 충돌 시 builtin 우선 — plugin 의 동일 id 는 skip + warn.
 */
export function getAllCliDefs(): CliDef[] {
  if (cachedAllDefs) return cachedAllDefs;
  const { defs: userDefs, warnings } = loadUserCliDefs();
  const builtinIds = new Set(BUILTIN_CLI_DEFS.map(c => c.id));
  const merged: CliDef[] = [...BUILTIN_CLI_DEFS];
  const collectedWarnings = [...warnings];
  for (const def of userDefs) {
    if (builtinIds.has(def.id)) {
      collectedWarnings.push(`${def.id}: builtin 과 id 충돌 — plugin 무시됨`);
      continue;
    }
    merged.push(def);
  }
  cachedAllDefs = merged;
  cachedWarnings = collectedWarnings;
  return cachedAllDefs;
}

/**
 * 가장 최근 getAllCliDefs 호출에서 누적된 plugin 로딩 경고.
 * TUI / CLI 시작 시 사용자에게 한 번 표시하기 위한 용도.
 */
export function getCliDefsWarnings(): string[] {
  if (cachedAllDefs === null) getAllCliDefs();  // ensure load
  return cachedWarnings.slice();
}

/**
 * 캐시 초기화. 테스트가 plugin 디렉토리 변경 후 재로드 강제할 때 사용.
 * production 에서는 호출하지 않는다.
 */
export function resetCliDefCache(): void {
  cachedAllDefs = null;
  cachedWarnings = [];
}

/** id 로 CLI 정의를 조회 (builtin + plugin 모두 검색). 없으면 undefined. */
export function findCliDef(id: string): CliDef | undefined {
  return getAllCliDefs().find(c => c.id === id);
}
