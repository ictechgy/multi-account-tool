/**
 * OpenCode 의 freshness adapter.
 *
 * OpenCode 의 `~/.local/share/opencode/auth.json` 구조:
 *   provider ID 마다 nested 객체. 예:
 *     {
 *       "openai": { "type": "oauth", "access": "...", "refresh": "...",
 *                   "accountId": "...", "expires": 1773758399728 },
 *       "anthropic": { "type": "api", "key": "..." }
 *     }
 *
 * 분류 전략:
 *  - 동일 provider 의 `accountId` 가 변경 → stale (다른 계정).
 *  - 동일 accountId + access/refresh 변경 → rotated value-only.
 *  - `expires` 만 변경 → rotated meta-only.
 *  - API key 모드 (`type: 'api'`) 는 `key` 비교 — 변경 시 stale.
 *  - 여러 provider 가 섞여 있으면 가장 심각한 결과를 채택 (stale > rotated > fresh).
 */

import type { CompareKind, CompareResult, RotatedSubtype, SourceAdapter } from '../freshness.js';

interface ProviderAuth {
  type?: 'oauth' | 'api';
  access?: string;
  refresh?: string;
  accountId?: string;
  expires?: number;
  key?: string;
}

type OpenCodeAuth = Record<string, ProviderAuth>;

function parse(raw: string): OpenCodeAuth | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object') return null;
    return v as OpenCodeAuth;
  } catch {
    return null;
  }
}

/** 단일 provider 비교. provider 가 한쪽에만 있는 경우는 호출자가 처리. */
function compareProvider(stored: ProviderAuth, live: ProviderAuth): CompareResult {
  if (stored.type === 'oauth' && live.type === 'oauth') {
    if (stored.accountId && live.accountId && stored.accountId !== live.accountId) {
      return { kind: 'stale', confidence: 'high', detail: `accountId 변경: ${stored.accountId} → ${live.accountId}` };
    }
    const tokenChanged = stored.access !== live.access || stored.refresh !== live.refresh;
    if (tokenChanged) {
      return { kind: 'rotated', subtype: 'value-only', confidence: 'high', detail: 'OAuth 토큰 rotation' };
    }
    return { kind: 'rotated', subtype: 'meta-only', confidence: 'high', detail: 'expires 등 캐시 필드만 변경' };
  }
  if (stored.type === 'api' && live.type === 'api') {
    return stored.key === live.key
      ? { kind: 'fresh', confidence: 'high', detail: 'API key 동일' }
      : { kind: 'stale', confidence: 'high', detail: 'API key 변경' };
  }
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'medium',
    detail: `provider type 불일치: stored=${stored.type ?? 'unknown'} live=${live.type ?? 'unknown'}`
  };
}

/**
 * 여러 provider 결과를 최악 우선으로 통합 (stale > rotated > inflight > fresh).
 *
 * 본 adapter 는 multi-provider 결과를 단일 saveAs 결과로 합치므로 `inflight`
 * 는 현재 호출 경로에서 직접 반환되지 않는다. `inflight` (multi-source 부분
 * 갱신 race) 는 freshness.ts 가 multi-source CLI 의 saveAs 별 결과를 cross-source
 * aggregation 으로 분류할 때만 의미 — 본 severity 순서는 그 통합 단계에서
 * rotated 보다 덜 위험 (in-flight 는 일시적, rotated 는 영구적) 으로 처리.
 */
const KIND_SEVERITY: Record<CompareKind, number> = { fresh: 0, inflight: 1, rotated: 2, stale: 3 };
const SUBTYPE_SEVERITY: Record<RotatedSubtype, number> = { 'meta-only': 0, 'value-only': 1, both: 2 };

function pickWorse(a: CompareResult, b: CompareResult): CompareResult {
  if (KIND_SEVERITY[a.kind] !== KIND_SEVERITY[b.kind]) {
    return KIND_SEVERITY[a.kind] > KIND_SEVERITY[b.kind] ? a : b;
  }
  if (a.kind === 'rotated' && b.kind === 'rotated' && a.subtype && b.subtype) {
    return SUBTYPE_SEVERITY[a.subtype] >= SUBTYPE_SEVERITY[b.subtype] ? a : b;
  }
  return a;
}

function compareOpencode(stored: string, live: string): CompareResult {
  if (stored === live) return { kind: 'fresh', confidence: 'high' };
  const s = parse(stored);
  const l = parse(live);
  if (!s || !l) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'OpenCode auth.json JSON parse 실패'
    };
  }
  const allProviders = new Set([...Object.keys(s), ...Object.keys(l)]);
  let worst: CompareResult = { kind: 'fresh', confidence: 'high' };
  for (const provider of allProviders) {
    const ps = s[provider];
    const pl = l[provider];
    let result: CompareResult;
    if (ps && pl) {
      result = compareProvider(ps, pl);
    } else {
      result = {
        kind: 'stale',
        confidence: 'high',
        detail: `provider ${provider} 가 한쪽에만 존재`
      };
    }
    worst = pickWorse(worst, result);
  }
  return worst;
}

export const opencodeAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs !== 'opencode-auth.json') {
      return {
        kind: 'rotated',
        subtype: 'both',
        confidence: 'low',
        detail: `OpenCode adapter: 미지원 source ${saveAs}`
      };
    }
    return compareOpencode(stored, live);
  }
};
