/**
 * 내장 AI CLI 정의 목록.
 * 새 CLI 를 추가하려면 BUILTIN_CLI_DEFS 에 항목을 추가하면 된다.
 */

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
  }
];

/** id 로 CLI 정의를 조회. 없으면 undefined. */
export function findCliDef(id: string): CliDef | undefined {
  return BUILTIN_CLI_DEFS.find(c => c.id === id);
}
