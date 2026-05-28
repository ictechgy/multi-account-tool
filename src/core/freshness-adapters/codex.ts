/**
 * Codex CLI 의 freshness adapter.
 *
 * Codex 의 `~/.codex/auth.json` 구조 (OpenAI OAuth + API key 옵션):
 *   - `tokens.access_token` / `refresh_token` / `id_token` — OAuth 토큰
 *   - `tokens.account_id` — UUID (identity 핵심 필드)
 *   - `last_refresh` — ISO 시각 (캐시 필드, 비교 무시)
 *   - `OPENAI_API_KEY` — API key 모드 (OAuth 미사용 시)
 *   - `auth_mode` — 'ChatGPT' 등
 *
 * identity 분류:
 *  - tokens.account_id 가 동일하면 = 같은 사용자. token 변경은 refresh rotation.
 *  - account_id 가 다르면 = 다른 사용자 (다른 계정으로 로그인됨).
 *  - API key 모드 (tokens 부재) 는 `OPENAI_API_KEY` 비교로 fallback.
 */

import type { CompareResult, SourceAdapter } from '../freshness.js';

interface CodexAuth {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  OPENAI_API_KEY?: string | null;
}

function parse(raw: string): CodexAuth | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object') return null;
    return v as CodexAuth;
  } catch {
    return null;
  }
}

function compareCodex(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const s = parse(stored);
  const l = parse(live);
  if (!s || !l) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'Codex auth.json JSON parse 실패 — 손상 가능성'
    };
  }
  const storedId = s.tokens?.account_id ?? null;
  const liveId = l.tokens?.account_id ?? null;
  if (storedId && liveId) {
    if (storedId !== liveId) {
      return { kind: 'stale', confidence: 'high', detail: 'tokens.account_id 변경 — 다른 계정' };
    }
    const tokenChanged =
      s.tokens?.access_token !== l.tokens?.access_token ||
      s.tokens?.refresh_token !== l.tokens?.refresh_token ||
      s.tokens?.id_token !== l.tokens?.id_token;
    return tokenChanged
      ? { kind: 'rotated', subtype: 'value-only', confidence: 'high', detail: 'identity 동일, token rotation' }
      : { kind: 'rotated', subtype: 'meta-only', confidence: 'high', detail: 'token 동일, 캐시 필드만 변경' };
  }
  if (s.OPENAI_API_KEY && l.OPENAI_API_KEY) {
    return s.OPENAI_API_KEY === l.OPENAI_API_KEY
      ? { kind: 'fresh', confidence: 'high', detail: 'API key 모드, 동일 키' }
      : { kind: 'stale', confidence: 'high', detail: 'OPENAI_API_KEY 변경 — 다른 키' };
  }
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'low',
    detail: 'identity 필드 부재 (tokens.account_id / OPENAI_API_KEY)'
  };
}

export const codexAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs !== 'auth.json') {
      return {
        kind: 'rotated',
        subtype: 'both',
        confidence: 'low',
        detail: `Codex adapter: 미지원 source ${saveAs}`
      };
    }
    return compareCodex(stored, live);
  }
};
