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
