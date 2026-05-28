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
 * identity 분류 (PR-H iter 1 quad-review 5건 HIGH 반영):
 *  - KeychainStored.account 양쪽 모두 string 이고 다르면 → stale (high).
 *  - account 가 한쪽만 string (XOR) → stale (low) — identity 안전망 우회 차단 (H4).
 *  - claudeAiOauth.subscriptionType 양쪽 모두 string 이고 다르면 → stale (medium).
 *  - subscriptionType 가 한쪽만 string (XOR) → stale (low) — identity downgrade 차단 (H3).
 *  - 양쪽 모두 subscriptionType 부재 + token 양쪽 부재 → rotated both (low) — 손상 추정 (H5).
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
import { parseJsonObject } from './_shared.js';

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
  /** wrapper 형태로 들어왔는지 (account 필드 자체 부재 여부). XOR 가드용. */
  hasWrapper: boolean;
}

/**
 * KeychainStored wrapper (macOS) 또는 raw credentials JSON (non-macOS) 모두 처리.
 *
 * wrapper 판정 휴리스틱: 최상위가 `value`(string) 키를 가지면 wrapper 로 간주.
 * `value` 가 string 이 아닌 경우 raw credentials 로 fallback (Claude credentials.json
 * 자체에도 `value` 필드가 등장하지 않으므로 충돌 위험 낮음).
 *
 * `hasWrapper` 는 outer wrapper 존재 여부 — wrapper 에서 account 부재(undefined)와
 * raw credentials 의 account-없음(true negative)을 구분해 XOR 분기에 사용.
 */
function unwrap(raw: string): Unwrapped {
  const outer = parseJsonObject<KeychainOuter>(raw);
  if (outer && typeof outer.value === 'string') {
    return {
      credentials: parseJsonObject<ClaudeCredentials>(outer.value),
      account: typeof outer.account === 'string' ? outer.account : null,
      hasWrapper: true
    };
  }
  return {
    credentials: parseJsonObject<ClaudeCredentials>(raw),
    account: null,
    hasWrapper: false
  };
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
  const accountVerdict = checkAccountIdentity(s, l);
  if (accountVerdict) return accountVerdict;
  return compareClaudeCredentials(s.credentials, l.credentials);
}

/**
 * KeychainStored.account 의 identity 검사 (H4 + iter 2 Codex-3 #3 정밀화).
 *
 * `account` 의 존재 판정은 `typeof === 'string'` — 빈 문자열 `''` 도 유효한 string
 * 으로 취급. 이전 truthiness (`s.account && ...`) 는 빈 string 을 absent 로 잘못
 * 분류해 XOR 분기 우회 가능 (iter 2 Codex-3 #3 fix).
 *
 * 분기 (mutually exclusive):
 *  - wrapper 형태 자체가 비대칭 → stale (low). 같은 이유로 우회 차단.
 *  - 양쪽 모두 string + 다름 → stale (high). 다른 macOS keychain user.
 *  - 양쪽 모두 string + 동일 → null (다음 단계 위임).
 *  - 한쪽만 string (XOR) → stale (low). wrapper 손상 추정.
 *  - 양쪽 모두 string 아님 → null (다음 단계 위임). non-macOS file source 정상 경로.
 */
function checkAccountIdentity(s: Unwrapped, l: Unwrapped): CompareResult | null {
  if (s.hasWrapper !== l.hasWrapper) {
    return {
      kind: 'stale',
      confidence: 'low',
      detail: 'KeychainStored wrapper 비대칭 — credentials 손상 추정'
    };
  }
  const sIsString = typeof s.account === 'string';
  const lIsString = typeof l.account === 'string';
  if (sIsString && lIsString) {
    if (s.account !== l.account) {
      return {
        kind: 'stale',
        confidence: 'high',
        detail: `Keychain account 변경: ${maskIdentifier(s.account!)} → ${maskIdentifier(l.account!)}`
      };
    }
    return null;
  }
  if (sIsString !== lIsString) {
    return {
      kind: 'stale',
      confidence: 'low',
      detail: 'KeychainStored.account 비대칭 — credentials 손상 추정'
    };
  }
  return null;
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
  const subscriptionVerdict = checkSubscriptionType(sOauth.subscriptionType, lOauth.subscriptionType);
  if (subscriptionVerdict) return subscriptionVerdict;
  return compareOauthTokens(sOauth, lOauth);
}

/**
 * subscriptionType 비교 (H3 quad-review iter 1 Strong HIGH fix).
 *
 * 분기:
 *  - 양쪽 동일 (둘 다 string 같은 값) → null (다음 단계 위임).
 *  - 양쪽 모두 string + 다름 → stale (medium).
 *  - 한쪽만 string (XOR) → stale (low) — Anthropic schema 변경 또는 손상.
 *    silent skip 시 token 비교 분기로 떨어져 identity downgrade attack.
 *  - 양쪽 모두 부재 → null (token 비교에 위임).
 */
function checkSubscriptionType(
  sType: string | undefined,
  lType: string | undefined
): CompareResult | null {
  if (sType === lType) return null;
  if (sType && lType) {
    return {
      kind: 'stale',
      confidence: 'medium',
      detail: `subscriptionType 변경 — 다른 plan/계정 추정`
    };
  }
  return {
    kind: 'stale',
    confidence: 'low',
    detail: 'subscriptionType 비대칭 — identity 확정 불가'
  };
}

/**
 * OAuth token 비교 (H5 quad-review iter 1 Strong HIGH fix).
 *
 * 분기:
 *  - 양쪽 모두 token 부재 + expiresAt 부재 → rotated both (low). 손상 추정.
 *  - 양쪽 모두 token 부재 + expiresAt 만 변경 → rotated meta-only (medium).
 *  - access/refresh 변경 → rotated value-only (high).
 *  - token 동일 + expiresAt 변경 → rotated meta-only (high).
 *  - 그 외 차이 → rotated both (medium).
 */
function compareOauthTokens(
  s: NonNullable<ClaudeCredentials['claudeAiOauth']>,
  l: NonNullable<ClaudeCredentials['claudeAiOauth']>
): CompareResult {
  const sHasTokens = !!(s.accessToken || s.refreshToken);
  const lHasTokens = !!(l.accessToken || l.refreshToken);
  if (!sHasTokens && !lHasTokens) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'OAuth token 양쪽 모두 부재 — credentials 손상 추정'
    };
  }
  const tokenChanged =
    s.accessToken !== l.accessToken ||
    s.refreshToken !== l.refreshToken;
  if (tokenChanged) {
    return {
      kind: 'rotated',
      subtype: 'value-only',
      confidence: 'high',
      detail: 'subscriptionType 동일, OAuth token rotation'
    };
  }
  if (s.expiresAt !== l.expiresAt) {
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
