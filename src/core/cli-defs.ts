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

import { join } from 'node:path';

import { loadUserCliDefs } from './cli-defs-plugin.js';
import type { CliDef, Source } from './types.js';
import { assertValidSourceList } from './validators.js';

/**
 * Claude Code 의 자격증명 source.
 * macOS 에서는 Keychain (`Claude Code-credentials`) 에,
 * 그 외 OS 에서는 `~/.claude/.credentials.json` 파일에 저장된다.
 */
function claudeSource(): Source {
  if (process.platform === 'darwin') {
    return { type: 'keychain', service: 'Claude Code-credentials', allowAnyApp: true, saveAs: 'credentials.json' };
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
 *    만 교체). macOS 와 마찬가지로 os-keyring 과 yaml 두 backend 를 동시 사용하지 말 것 —
 *    keyring 미가용 환경에서 stale yaml swap(wrong-account) 위험. secret-tool
 *    (libsecret-tools) + keyring daemon 이 있어야 동작한다. **secret-tool 미설치(ENOENT)도
 *    fail-closed** — yaml fallback 으로 stale credential 을 쓰지 않게 명시 에러로 막는다 (#59/#73).
 *    entry 부재(exit 0+빈 출력)는 정상 skip → yaml fallback.
 *  - **Linux/macOS (file backend)**: `GOOSE_DISABLE_KEYRING` 가 **존재하면**(값 무관,
 *    gooseUsesFileBackend) keyring source 를 **생략**하고 `secrets.yaml` + `config.yaml` 만
 *    swap. Goose 의 presence-only env 시맨틱에 맞춘 이유는 gooseUsesFileBackend 주석 참고 (#59).
 *  - **그 외 OS** (win32/freebsd 등): `secrets.yaml` + `config.yaml` 만. Windows Credential
 *    Manager 는 별도 후속 plan (PR-W).
 *
 * 한계 (README/ROADMAP 명시):
 *  - Linux 기본(keyring) 사용자는 secret-tool (libsecret-tools) + keyring daemon 이 필요하다.
 *    secret-tool 미설치(ENOENT)도 명시 에러다. file backend 면 `GOOSE_DISABLE_KEYRING=1` 로
 *    os-keyring 을 끄면 yaml 로 swap 된다. ENOENT 아닌 spawn 실패(EACCES 등)·daemon-down/접근거부도
 *    명시 에러로 유지 (tool/infra 문제를 항목 부재로 오인하지 않음, #73).
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
 * 따라서 확실한 disable 신호가 없으면 os-keyring 을 포함한다. secret-tool 미설치(ENOENT)
 * 자체는 source 포함/생략 판정에 쓰지 않고, 읽기 시점에 os-keyring.ts 가 fail-closed 로
 * 처리한다 (#59/#73) — tool 부재를 file backend 신호로 오인하지 않는다.
 *
 * 한계: `~/.config/goose/config.yaml` 의 file-backend 설정은 자동 감지하지 않는다. 그 경우
 * `GOOSE_DISABLE_KEYRING=1` 을 함께 지정해 os-keyring source 를 명시적으로 끈다.
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
  // Upstream admission: aaif-goose/goose v1.43.0, commit
  // 5a9eb7edea1e081e2d54473ae41481f0289b826a. Fixed paths only; no provider
  // discovery and no session capability are introduced here.
  const providerSources: Source[] = [
    { type: 'file', path: '~/.config/goose/providers/gemini_oauth/tokens.json', saveAs: 'goose-provider-gemini-oauth-tokens.json' },
    { type: 'file', path: '~/.config/goose/providers/chatgpt_codex/tokens.json', saveAs: 'goose-provider-chatgpt-codex-tokens.json' },
    { type: 'file', path: '~/.config/goose/providers/kimicode/token.json', saveAs: 'goose-provider-kimicode-token.json' },
    { type: 'directory', path: '~/.config/goose/providers/githubcopilot', saveAs: 'goose-provider-githubcopilot.tree.json', maxEntries: 128, maxBytes: 1_048_576, maxDepth: 8 },
    { type: 'file', path: '~/.config/goose/providers/xai_oauth/tokens.json', saveAs: 'goose-provider-xai-oauth-tokens.json' },
    { type: 'directory', path: '~/.config/goose/providers/databricks/oauth', saveAs: 'goose-provider-databricks-oauth.tree.json', maxEntries: 128, maxBytes: 1_048_576, maxDepth: 8 },
    { type: 'file', path: '~/.config/goose/providers/huggingface/oauth/tokens.json', saveAs: 'goose-provider-huggingface-oauth-tokens.json' }
  ];
  // file backend(GOOSE_DISABLE_KEYRING 존재) 면 macOS 도 keychain 을 생략한다 — Goose 가
  // file backend 일 때 stale keychain 항목을 swap 하는 wrong-account 위험 차단 (Linux 와 대칭).
  if (process.platform === 'darwin' && !gooseUsesFileBackend()) {
    return [
      { type: 'keychain', service: 'goose', account: 'secrets', allowAnyApp: true, saveAs: 'goose-keyring.json' },
      ...yamlSources, ...providerSources
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
      ...yamlSources, ...providerSources
    ];
  }
  return [...yamlSources, ...providerSources];
}

/**
 * OpenCode 의 data root (`auth.json` 이 들어가는 디렉토리).
 *
 * OpenCode current source 는 npm `xdg-basedir` 의 `xdgData` 아래 `opencode/auth.json` 을 쓴다.
 * 따라서 사용자가 `XDG_DATA_HOME` 을 설정한 환경에서 mat 도 같은 live credential 경로를 읽어야
 * wrong-capture 를 피할 수 있다. env 미설정/빈 문자열은 xdg 기본값(`~/.local/share`)로 둔다.
 */
function opencodeDataRoot(): string {
  const dataHome = process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
    ? process.env.XDG_DATA_HOME
    : '~/.local/share';
  return join(dataHome, 'opencode');
}

const OPENCODE_SESSION_WARNING =
  'EXPERIMENTAL OpenCode: XDG_DATA_HOME is redirected; other XDG tools (e.g. Crush) may write data/credentials into this ephemeral session dir and lose them at exit.';


export const BUILTIN_CLI_DEFS: CliDef[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    sources: [claudeSource()],
    // CLAUDE_CONFIG_DIR 로 ~/.claude 전체 재배치 가능. base 직속이라 envSubdir 불필요.
    // share=∅ — settings.json 은 자격증명+config 혼재라 share 금지(세션 ephemeral).
    //
    // platform 별 동작 (session 정의 자체는 unconditional — planSession 이 source 종류로 분기):
    //  (a) 비-macOS(linux 등): claudeSource()=file(`~/.claude/.credentials.json`, base 직속)이라
    //      planSession 이 정상 격리한다 (동시 다계정 동작).
    //  (b) macOS: claudeSource()=keychain 이라 planSession 이 비-file source 로 미지원 throw —
    //      keychain 자격증명은 env 디렉토리 리다이렉트로 격리할 수 없다(파일이 아니라 OS 보안 저장소).
    //  (c) CLAUDE_CONFIG_DIR 는 비공식·미문서 env 라 Claude Code 릴리스 변경 리스크가 있다.
    //  (d) settings.json 의 세션 내 변경은 ephemeral — 종료 시 base 에 반영되지 않는다(알려진 한계,
    //      share=∅ 의 결과).
    //  (e) CLAUDE_CODE_OAUTH_TOKEN 은 종료 시 keychain 항목을 삭제하는 부작용이 있어 사용 금지.
    session: { roots: [{ env: 'CLAUDE_CONFIG_DIR', base: '~/.claude' }] },
    sessionRun: { executable: 'claude' }
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    sources: [
      { type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }
    ],
    // CODEX_HOME 으로 ~/.codex 전체 재배치 가능 (auth.json 포함). 세션 격리 지원.
    // config.toml 은 secret-free read-mostly 설정(모델/MCP/feature flag 등)이라 세션 시작 시
    // base 에서 **0600 복사**(copy-isolate, issue #72) — 시작 시점 설정 재현(UX)은 유지하되,
    // 세션 내 `codex mcp add`/`plugin add` 가 config.toml 에 써도 base 가 오염되지 않는다(write-back
    // 없음). skills/ 도 같은 copy-isolate 경계로 세션에 스냅샷 복사한다(세션 내 skill 변경은 폐기).
    // OAuth 토큰은 auth.json 에만 있으며 source 로 격리 복사된다 (issue #63-3).
    session: {
      roots: [
        {
          env: 'CODEX_HOME',
          base: '~/.codex',
          share: ['config.toml'],
          shareDirs: [{ rel: 'skills' }]
        }
      ]
    },
    sessionRun: { executable: 'codex' }
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    sources: [
      { type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' },
      { type: 'file', path: '~/.gemini/google_accounts.json', saveAs: 'google_accounts.json' }
    ],
    // GEMINI_CLI_HOME 으로 ~/.gemini 재배치 가능. 단, 이 env 는 `.gemini` 의 **부모**를 가리킨다
    // (소스 실측: homedir()=GEMINI_CLI_HOME, getGlobalGeminiDir()=join(homedir(),'.gemini') —
    // .omc/research/pr-g0-gemini-cli-home-gate.md) → envSubdir='.gemini' 로 cred 루트를 한 단계 내림.
    // sources 불변(oauth_creds.json + google_accounts.json 2개). 2-cred 는 기존 runRecaptureLocked
    // 가 원자 그룹으로 처리하므로 신규 인프라 불필요. share=∅ — settings.json write-back 가능성이
    // 있어 미공유(통째 ephemeral).
    //
    // Google Antigravity CLI(`agy`)는 Gemini CLI 와 별도다. 공식 문서는 토큰을 OS native
    // keyring(Apple Keychain / Linux Secret Service / Windows Credential Manager)에 저장한다고 설명하고,
    // 설정/플러그인/cache 는 `~/.gemini/antigravity-cli/` 하위에 둔다. 로컬 agy 1.0.7 실측상
    // `GEMINI_CLI_HOME`, XDG env, `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 는 그 app-data root 를 옮기지
    // 못했고, broad `HOME` 만 영향을 줬다. 0600 `antigravity-oauth-token` 파일이 관찰될 수 있지만
    // keyring/파일 저장 계약과 세션용 redirect 가 안정 문서화되기 전까지 mat source/session 으로
    // 지원하지 않는다(부분 auth 격리 금지).
    session: { roots: [{ env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini' }] },
    sessionRun: { executable: 'gemini' }
  },
  {
    // Aider 는 `~/.aider.conf.yml` 에 모델 + API key 를 텍스트로 보관 (env var 사용자는 별도 워크플로 필요).
    // 빌트인 추가 가치는 "기본 제공" 편의성 — plugin JSON 작성 없이 즉시 사용 가능.
    id: 'aider',
    name: 'Aider',
    sources: [
      { type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }
    ],
    // `session start` 는 계속 미지원(세션 재배치 env 없음). `session run` 만 mat 이
    // forced --config/--env-file 과 env/argv/dotenv/model-sidecar hard-stop 을 소유하는
    // command-scoped partial support 로 연다.
    sessionRun: { executable: 'aider' }
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
    session: { roots: [{ env: 'KIMI_SHARE_DIR', base: '~/.kimi' }] },
    sessionRun: { executable: 'kimi' }
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
    // QWEN_HOME 으로 ~/.qwen 재배치 가능 (settings.json + .env 포함). 세션 시작만 지원.
    // settings.json 이 자격증명+config 혼재라 share 후보 없음 — 통째 격리 복사.
    // G001 Option D: Qwen v0.19.10의 설정·dotenv·interactive CWD/auth 경로 전체를
    // command preflight로 안전하게 닫을 수 있을 때까지 session run 은 열지 않는다.
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
    },
    sessionRun: { executable: 'crush' }
  },
  {
    // SST OpenCode (https://github.com/sst/opencode). MIT 라이선스 오픈소스 AI 코딩 에이전트.
    // credential 은 단일 JSON 파일 `auth.json`. 권한 0o600.
    // provider ID 마다 `{ type: 'api', key: ... }` 또는 OAuth 토큰 객체.
    //
    // 경로 — `packages/core/src/global.ts` 가 npm `xdg-basedir` 의 `xdgData` 를 사용:
    //   `${xdgData}/opencode/auth.json`. xdg-basedir 는 **OS 무관 XDG 표준** 만 따른다
    //   (Apple Application Support 등 native 경로 분기 없음) → macOS / Linux / BSD / Windows 모두
    //   기본값 `~/.local/share/opencode/auth.json`. `XDG_DATA_HOME` 이 설정돼 있으면
    //   `$XDG_DATA_HOME/opencode/auth.json` 을 live credential 로 본다. (이전 조사가 etcetera Rust
    //   패턴으로 macOS Apple base dir 분기를 가정했으나 npm xdg-basedir 동작과 다름 — PR #28
    //   quad-review 정정 사항).
    //
    // mat scope 밖 한계 (PR #28 quad-review Codex HIGH 반영):
    //   - `OPENCODE_AUTH_CONTENT` env 가 설정되면 OpenCode 가 파일 대신 env 내용 우선 사용.
    //   - `OPENCODE_CONFIG_DIR` env 로 디렉토리 자체 override 시 기본 경로 swap 무효.
    //   - `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 로 config 자체를 주입하면 별도 provider 라우팅 가능.
    //   - 프로젝트 로컬 `opencode.json` / `opencode.jsonc` / `.opencode/opencode.json` + 프로젝트 `.env` 도
    //     provider env 참조를 통해 credential 선택에 영향. (cwd 기반은 mat scope 밖)
    //   - config 내 `"apiKey": "{env:ANTHROPIC_API_KEY}"` env 참조 사용 시 shell env 가 실제 key 결정.
    //
    // session(EXPERIMENTAL): OpenCode 에는 현재 OPENCODE_DATA_DIR 같은 CLI 전용 data redirect 가 없다.
    // auth.json 은 XDG data root 하위라 `XDG_DATA_HOME=<session>/XDG_DATA_HOME` + envSubdir='opencode'
    // 으로 격리 가능하지만, 이 env 는 subshell 전체의 XDG-aware 도구에 영향을 준다(예: Crush 를
    // 세션 안에서 인증하면 그 data/credential 이 ephemeral session dir 에 쓰였다가 종료 시 삭제될 수
    // 있음). 그래서 시작 시 경고를 출력하고 README/spec 에 EXPERIMENTAL 로 문서화한다. OpenCode
    // config/env/project-local apiKey 경로는 여전히 mat scope 밖.
    id: 'opencode',
    name: 'OpenCode',
    sources: [
      { type: 'file', path: join(opencodeDataRoot(), 'auth.json'), saveAs: 'opencode-auth.json' }
    ],
    session: {
      roots: [
        {
          env: 'XDG_DATA_HOME',
          base: opencodeDataRoot(),
          envSubdir: 'opencode',
          warning: OPENCODE_SESSION_WARNING
        }
      ]
    },
    sessionRun: { executable: 'opencode' }
  },
  {
    // Block 의 오픈소스 AI agent (https://github.com/block/goose).
    // PR-A 의 KeychainSource.account optional 필드를 사용하는 첫 builtin —
    // service `goose` 가 generic 단어라 account scope 가 필수 (wrong-entry 차단).
    // platform 분기 및 한계는 gooseSources() 의 JSDoc 참고.
    id: 'goose',
    name: 'Goose',
    sources: gooseSources()
  },
  {
    // xAI Grok Build CLI PR1 profile-swap-only support.
    // Grok's primary signed-in browser/OIDC credential is `~/.grok/auth.json`; MAT stores
    // that single file as `grok-auth.json`. Do not add `session`/`sessionRun` here in PR1:
    // `~/.grok/config.toml`, project `.grok/config.toml`, `GROK_HOME`, `XAI_API_KEY`,
    // `GROK_*` auth/model env, and MCP credential config can outrank or bypass auth.json.
    id: 'grok',
    name: 'Grok Build',
    sources: [
      { type: 'file', path: '~/.grok/auth.json', saveAs: 'grok-auth.json' }
    ]
  }
];

for (const def of BUILTIN_CLI_DEFS) assertValidSourceList(def.sources);

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
