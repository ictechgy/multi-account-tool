/**
 * Claude Code (Anthropic) 의 freshness adapter.
 *
 * Source (cli-defs.ts claudeSource):
 *  - macOS: keychain `{ service: 'Claude Code-credentials', saveAs: 'credentials.json' }`.
 *    `readSource` 가 KeychainStored wrapper (`{value: <inner JSON 문자열>, account?: string}`)
 *    JSON 으로 직렬화한 문자열을 반환 — adapter 는 outer parse 후 inner value 를
 *    Claude credentials JSON 으로 재parse.
 *  - 비-macOS: file `~/.claude/.credentials.json` (동일 saveAs). raw JSON 본문.
 *
 * Anthropic Claude Code 의 credentials.json 구조 (관찰된 typical schema):
 *   {
 *     "claudeAiOauth": {
 *       "accessToken": "...",
 *       "refreshToken": "...",
 *       "expiresAt": 1234567890,
 *       "scopes": [...],
 *       "subscriptionType": "claudeai" | "claudepro" | "max" | "enterprise"
 *     }
 *   }
 *
 * identity 분류:
 *  - KeychainStored.account 가 다르면 → stale (다른 macOS keychain account — 안전망).
 *  - claudeAiOauth.subscriptionType 가 다르면 → stale, medium confidence (다른 plan/
 *    계정 추정). plan 만으로 100% 계정 동일성 단정 불가지만 fallback 보다 정확.
 *  - subscriptionType 동일 + accessToken/refreshToken 변경 → rotated value-only (high).
 *  - token 동일 + expiresAt 만 변경 → rotated meta-only (high).
 *  - 그 외 차이 (scopes 추가 등) → rotated both (medium).
 *
 * 한계 명시:
 *  - credentials.json 에 안정적 user_id / email 필드가 없다 (Anthropic 이 노출 안 함).
 *    같은 subscriptionType 의 다른 계정으로 swap 됐다면 본 adapter 는 stale 을 못 잡고
 *    rotated 로 분류. 보수적이지만 fallback (전부 low conf) 보다는 정보량 큼.
 *  - 향후 Anthropic 이 credentials 에 user identifier 노출 시 본 adapter 확장.
 */

import { maskIdentifier } from '../errors.js';
import type { CompareResult, SourceAdapter } from '../freshness.js';

interface KeychainOuter {
  value?: unknown;
  account?: unknown;
}

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
}

interface Unwrapped {
  credentials: ClaudeCredentials | null;
  account: string | null;
}

function parseJsonObject<T>(raw: string): T | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as T;
  } catch {
    return null;
  }
}

/**
 * KeychainStored wrapper (macOS) 또는 raw credentials JSON (non-macOS) 모두 처리.
 *
 * wrapper 판정 휴리스틱: 최상위가 `value`(string) 키를 가지면 wrapper 로 간주.
 * `value` 가 string 이 아닌 경우 raw credentials 로 fallback (Claude credentials.json
 * 자체에도 `value` 필드가 등장하지 않으므로 충돌 위험 낮음).
 */
function unwrap(raw: string): Unwrapped {
  const outer = parseJsonObject<KeychainOuter>(raw);
  if (outer && typeof outer.value === 'string') {
    return {
      credentials: parseJsonObject<ClaudeCredentials>(outer.value),
      account: typeof outer.account === 'string' ? outer.account : null
    };
  }
  return { credentials: parseJsonObject<ClaudeCredentials>(raw), account: null };
}

function compareClaude(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const s = unwrap(stored);
  const l = unwrap(live);
  if (!s.credentials || !l.credentials) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'Claude credentials JSON parse 실패 — 손상 가능성'
    };
  }
  if (s.account && l.account && s.account !== l.account) {
    return {
      kind: 'stale',
      confidence: 'high',
      detail: `Keychain account 변경: ${maskIdentifier(s.account)} → ${maskIdentifier(l.account)}`
    };
  }
  return compareClaudeCredentials(s.credentials, l.credentials);
}

function compareClaudeCredentials(s: ClaudeCredentials, l: ClaudeCredentials): CompareResult {
  const sOauth = s.claudeAiOauth;
  const lOauth = l.claudeAiOauth;
  if (!sOauth || !lOauth) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'claudeAiOauth 필드 부재 — API key 모드 또는 손상'
    };
  }
  if (sOauth.subscriptionType && lOauth.subscriptionType && sOauth.subscriptionType !== lOauth.subscriptionType) {
    return {
      kind: 'stale',
      confidence: 'medium',
      detail: `subscriptionType 변경 — 다른 plan/계정 추정`
    };
  }
  const tokenChanged =
    sOauth.accessToken !== lOauth.accessToken ||
    sOauth.refreshToken !== lOauth.refreshToken;
  if (tokenChanged) {
    return {
      kind: 'rotated',
      subtype: 'value-only',
      confidence: 'high',
      detail: 'subscriptionType 동일, OAuth token rotation'
    };
  }
  if (sOauth.expiresAt !== lOauth.expiresAt) {
    return {
      kind: 'rotated',
      subtype: 'meta-only',
      confidence: 'high',
      detail: 'token 동일, expiresAt 만 변경'
    };
  }
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'medium',
    detail: '기타 OAuth 필드 변경 (scopes 등)'
  };
}

export const claudeAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs !== 'credentials.json') {
      return {
        kind: 'rotated',
        subtype: 'both',
        confidence: 'low',
        detail: `Claude adapter: 미지원 source ${saveAs}`
      };
    }
    return compareClaude(stored, live);
  }
};
