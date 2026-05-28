/**
 * OpenCode adapter 단위 테스트 — provider별 분기 + pickWorse.
 *
 * 핵심 invariant:
 *  - OAuth provider: accountId 변경 → stale, token 변경 → rotated value-only
 *  - API key provider: key 비교
 *  - 한쪽에만 provider 존재 → stale (provider 추가/제거)
 *  - 여러 provider 결과는 최악 우선 (stale > rotated > fresh)
 *  - 미지원 saveAs → low confidence fallback
 */

import { describe, expect, it } from 'vitest';

import { opencodeAdapter } from '../../../src/core/freshness-adapters/opencode.js';

const SAVE_AS = 'opencode-auth.json';

describe('opencodeAdapter — OAuth provider', () => {
  it('동일 accountId + token 변경 → rotated value-only', () => {
    const stored = JSON.stringify({
      openai: { type: 'oauth', accountId: 'u1', access: 'oa', refresh: 'or', expires: 1 }
    });
    const live = JSON.stringify({
      openai: { type: 'oauth', accountId: 'u1', access: 'na', refresh: 'nr', expires: 2 }
    });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('accountId 변경 → stale + detail PII 마스킹 (quad-review MED fix)', () => {
    const stored = JSON.stringify({
      openai: { type: 'oauth', accountId: 'alice-uuid-12345', access: 'a', refresh: 'r' }
    });
    const live = JSON.stringify({
      openai: { type: 'oauth', accountId: 'bob-uuid-67890', access: 'a', refresh: 'r' }
    });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.detail).toMatch(/accountId 변경/);
    expect(r.detail).not.toContain('alice-uuid-12345');
    expect(r.detail).not.toContain('bob-uuid-67890');
    expect(r.detail).toMatch(/<hash:[0-9a-f]{12}>/);
  });

  it('token 동일 + expires 만 변경 → rotated meta-only', () => {
    const base = { type: 'oauth' as const, accountId: 'u', access: 'a', refresh: 'r' };
    const stored = JSON.stringify({ openai: { ...base, expires: 1 } });
    const live = JSON.stringify({ openai: { ...base, expires: 2 } });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });
});

describe('opencodeAdapter — API key provider', () => {
  it('동일 key → fresh', () => {
    const raw = JSON.stringify({ anthropic: { type: 'api', key: 'sk-x' } });
    expect(opencodeAdapter.compare(SAVE_AS, raw, raw).kind).toBe('fresh');
  });

  it('key 변경 → stale', () => {
    const stored = JSON.stringify({ anthropic: { type: 'api', key: 'sk-old' } });
    const live = JSON.stringify({ anthropic: { type: 'api', key: 'sk-new' } });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.detail).toMatch(/API key 변경/);
  });
});

describe('opencodeAdapter — multi-provider pickWorse', () => {
  it('provider 한쪽 추가 → stale (provider 한쪽에만 존재)', () => {
    const stored = JSON.stringify({ openai: { type: 'api', key: 'k' } });
    const live = JSON.stringify({
      openai: { type: 'api', key: 'k' },
      anthropic: { type: 'api', key: 'k2' }
    });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.detail).toMatch(/provider anthropic .* 한쪽/);
  });

  it('OpenAI rotated + Anthropic fresh → 통합 결과 rotated', () => {
    const stored = JSON.stringify({
      openai: { type: 'oauth', accountId: 'u', access: 'a', refresh: 'old' },
      anthropic: { type: 'api', key: 'k' }
    });
    const live = JSON.stringify({
      openai: { type: 'oauth', accountId: 'u', access: 'a', refresh: 'new' },
      anthropic: { type: 'api', key: 'k' }
    });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('OpenAI stale + Anthropic rotated → 통합 결과 stale (가장 심각)', () => {
    const stored = JSON.stringify({
      openai: { type: 'oauth', accountId: 'alice', access: 'a', refresh: 'r' },
      anthropic: { type: 'api', key: 'old' }
    });
    const live = JSON.stringify({
      openai: { type: 'oauth', accountId: 'bob', access: 'a', refresh: 'r' },
      anthropic: { type: 'api', key: 'new' }
    });
    const r = opencodeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
  });
});

describe('opencodeAdapter — 미지원 saveAs / parse 실패', () => {
  it('미지원 saveAs → low confidence', () => {
    const r = opencodeAdapter.compare('unknown.json', '{}', '{}');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/미지원 source/);
  });

  it('parse 실패 → rotated both (low)', () => {
    const r = opencodeAdapter.compare(SAVE_AS, 'not json', '{}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
  });

  it('JSON array → rotated both (low) — _shared.parseJsonObject array reject 회귀 가드', () => {
    const r = opencodeAdapter.compare(SAVE_AS, '[]', '{}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });
});
