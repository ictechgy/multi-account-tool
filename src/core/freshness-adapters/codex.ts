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
import { parseJsonObject } from './_shared.js';
import { freshnessDetail } from '../freshness-detail.js';

interface CodexAuth {
  tokens?: {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    account_id?: string;
  };
  OPENAI_API_KEY?: string | null;
}

function compareCodex(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const s = parseJsonObject<CodexAuth>(stored);
  const l = parseJsonObject<CodexAuth>(live);
  if (!s || !l) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      ...freshnessDetail('codexParseFailed')
    };
  }
  const storedId = s.tokens?.account_id ?? null;
  const liveId = l.tokens?.account_id ?? null;
  if (storedId && liveId) {
    if (storedId !== liveId) {
      return { kind: 'stale', confidence: 'high', ...freshnessDetail('codexAccountChanged') };
    }
    const tokenChanged =
      s.tokens?.access_token !== l.tokens?.access_token ||
      s.tokens?.refresh_token !== l.tokens?.refresh_token ||
      s.tokens?.id_token !== l.tokens?.id_token;
    return tokenChanged
      ? { kind: 'rotated', subtype: 'value-only', confidence: 'high', ...freshnessDetail('codexTokenRotation') }
      : { kind: 'rotated', subtype: 'meta-only', confidence: 'high', ...freshnessDetail('codexCacheOnly') };
  }
  if (s.OPENAI_API_KEY && l.OPENAI_API_KEY) {
    return s.OPENAI_API_KEY === l.OPENAI_API_KEY
      ? { kind: 'fresh', confidence: 'high', ...freshnessDetail('codexApiKeySame') }
      : { kind: 'stale', confidence: 'high', ...freshnessDetail('codexApiKeyChanged') };
  }
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'low',
    ...freshnessDetail('codexIdentityMissing')
  };
}

export const codexAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs !== 'auth.json') {
      return {
        kind: 'rotated',
        subtype: 'both',
        confidence: 'low',
        ...freshnessDetail('unsupportedSource', 'Codex', saveAs)
      };
    }
    return compareCodex(stored, live);
  }
};
