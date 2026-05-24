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
