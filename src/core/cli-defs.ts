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
 * Block (Square) 의 Goose AI agent (https://github.com/block/goose). Rust 구현.
 * `crates/goose/src/config/` 의 paths.rs + base.rs 직접 확인 (PR #29 작성 시):
 *  - macOS: Keychain service `goose` (system-keyring feature 활성 기본). KEYRING_USERNAME `secrets`.
 *  - Linux: secret-service 백엔드 (mat 미지원) 또는 `GOOSE_DISABLE_KEYRING` 시 config.yaml file fallback.
 * Linux 의 secret-service 는 mat 의 source 추상화 (file / macOS keychain) 로 표현 불가 →
 * Linux 분기는 file fallback path (`~/.config/goose/config.yaml`) 로 통일. 사용자가
 * Linux + system-keyring 사용 시 mat 가 swap 못함을 README/CHANGELOG 한계로 명시.
 */
function gooseSource(): Source {
  if (process.platform === 'darwin') {
    return { type: 'keychain', service: 'goose', saveAs: 'goose-secrets.json' };
  }
  return { type: 'file', path: '~/.config/goose/config.yaml', saveAs: 'goose-config.yaml' };
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
    ]
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
    ]
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
    ]
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
    ]
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
    // Block (Square) Goose (https://github.com/block/goose). Rust AI agent — file/keyring 양쪽 지원.
    // 경로 확인 (block/goose `crates/goose/src/config/paths.rs` 코드 주석):
    //   "Block" is kept here for backwards compatibility with existing user config/data directories
    //   (e.g. ~/Library/Application Support/Block/goose/).
    // base.rs 에서 KEYRING_SERVICE="goose", KEYRING_USERNAME="secrets", CONFIG_YAML_NAME="config.yaml".
    //
    // 정책 (mat 의 keychain source 는 macOS 만 지원):
    //   - macOS: Keychain service `goose` (Goose 의 기본 동작 — system-keyring feature 활성).
    //   - Linux: file `~/.config/goose/config.yaml` (Goose 의 keyring fallback / Linux 의 secret-service
    //     백엔드는 mat 미지원).
    //
    // mat scope 밖 한계:
    //   - macOS 에서 `GOOSE_DISABLE_KEYRING=1` 시 Goose 가 file fallback → mat 의 keychain swap 무효.
    //   - Linux + system-keyring (secret-service) 활성화 시 Goose 가 file 외 keyring 사용 → mat swap 미적용.
    //   - macOS 의 model/provider 라우팅 config (`~/Library/Application Support/Block/goose/config.yaml`)
    //     는 mat 가 swap 하지 않음 — secrets 만 swap, provider 라우팅은 한 사용자가 유지.
    //   - provider env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY` 등) 직접 export 시
    //     shell env 가 우선 → swap 우회.
    id: 'goose',
    name: 'Goose',
    sources: [gooseSource()]
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
