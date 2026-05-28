/**
 * Gemini / Antigravity 의 freshness adapter.
 *
 * Gemini 의 두 source:
 *  - `~/.gemini/oauth_creds.json`: Google OAuth 토큰 (`access_token`, `refresh_token`,
 *    `id_token`, `expiry_date`, `scope`, `token_type`). identity 식별 필드 없음
 *    — token 자체는 사용자 정보 디코드 가능하나 비교 비용/복잡도 vs 가치 trade-off.
 *  - `~/.gemini/google_accounts.json`: `{ active: <email>, old: [<email>...] }`.
 *    `active` 가 identity 의 핵심 (현재 로그인된 Google 계정 이메일).
 *
 * 분류 전략:
 *  - `google_accounts.json` 의 `active` 비교로 identity 변경 감지.
 *  - `oauth_creds.json` 은 `refresh_token` / `access_token` / `id_token` 변경 시 rotation
 *    (`expiry_date` 만 변경되면 meta-only).
 *
 * `inflight` 감지: 두 source 가 의미상 묶여 있는데 oauth_creds 만 갱신되고
 * google_accounts 가 stale 인 케이스는 호출자 (freshness.ts) 가 saveAs 별 결과를
 * 받아 cross-source aggregation 으로 판단 — 본 adapter 는 각 saveAs 만 책임.
 */

import { maskIdentifier } from '../errors.js';
import type { CompareResult, SourceAdapter } from '../freshness.js';

interface OAuthCreds {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expiry_date?: number;
}

interface GoogleAccounts {
  active?: string;
  old?: string[];
}

function parseObject<T>(raw: string): T | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object') return null;
    return v as T;
  } catch {
    return null;
  }
}

function compareOauthCreds(stored: string, live: string): CompareResult {
  if (stored === live) return { kind: 'fresh', confidence: 'high' };
  const s = parseObject<OAuthCreds>(stored);
  const l = parseObject<OAuthCreds>(live);
  if (!s || !l) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'oauth_creds.json JSON parse 실패'
    };
  }
  const tokenChanged =
    s.access_token !== l.access_token ||
    s.refresh_token !== l.refresh_token ||
    s.id_token !== l.id_token;
  if (tokenChanged) {
    return {
      kind: 'rotated',
      subtype: 'value-only',
      confidence: 'high',
      detail: 'OAuth 토큰 변경 — google_accounts.active 와 함께 검토 필요'
    };
  }
  return {
    kind: 'rotated',
    subtype: 'meta-only',
    confidence: 'high',
    detail: '토큰 동일, expiry_date/scope 등만 변경'
  };
}

function compareGoogleAccounts(stored: string, live: string): CompareResult {
  if (stored === live) return { kind: 'fresh', confidence: 'high' };
  const s = parseObject<GoogleAccounts>(stored);
  const l = parseObject<GoogleAccounts>(live);
  if (!s || !l) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'google_accounts.json JSON parse 실패'
    };
  }
  if (s.active && l.active) {
    if (s.active !== l.active) {
      return {
        kind: 'stale',
        confidence: 'high',
        // raw email 노출 회피 — maskIdentifier 로 stable fingerprint 만 표시.
        detail: `active 계정 변경: ${maskIdentifier(s.active)} → ${maskIdentifier(l.active)}`
      };
    }
    return {
      kind: 'rotated',
      subtype: 'meta-only',
      confidence: 'high',
      detail: 'active 동일, old 목록만 변경'
    };
  }
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'medium',
    detail: 'active 필드 부재 — identity 확정 불가'
  };
}

export const geminiAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs === 'oauth_creds.json') return compareOauthCreds(stored, live);
    if (saveAs === 'google_accounts.json') return compareGoogleAccounts(stored, live);
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: `Gemini adapter: 미지원 source ${saveAs}`
    };
  }
};
