/**
 * Codex adapter 단위 테스트 — `~/.codex/auth.json` 의 identity-aware 비교.
 *
 * 핵심 invariant:
 *  - tokens.account_id 동일 + token 변경 → rotated value-only (high confidence)
 *  - tokens.account_id 변경 → stale (다른 계정)
 *  - token 동일 + 캐시 필드 (last_refresh) 만 변경 → rotated meta-only
 *  - API key 모드 (OPENAI_API_KEY) 는 key 비교
 *  - JSON parse 실패 → rotated both (low confidence)
 *  - 미지원 saveAs → low confidence fallback
 */

import { describe, expect, it } from 'vitest';

import { codexAdapter } from '../../../src/core/freshness-adapters/codex.js';

const SAVE_AS = 'auth.json';

function makeAuth(tokens: Partial<{ access_token: string; refresh_token: string; id_token: string; account_id: string }>, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ auth_mode: 'ChatGPT', tokens, OPENAI_API_KEY: null, ...extra });
}

describe('codexAdapter — identity-aware 비교', () => {
  it('byte-identical → fresh', () => {
    const raw = makeAuth({ account_id: 'a', refresh_token: 'r' });
    expect(codexAdapter.compare(SAVE_AS, raw, raw)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('account_id 동일 + token 변경 → rotated value-only (high)', () => {
    const stored = makeAuth({ account_id: 'same', refresh_token: 'old', access_token: 'oa' });
    const live = makeAuth({ account_id: 'same', refresh_token: 'new', access_token: 'na' });
    const r = codexAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('high');
  });

  it('account_id 동일 + token 동일 + last_refresh 만 변경 → rotated meta-only', () => {
    const tokens = { account_id: 'same', refresh_token: 'r', access_token: 'a' };
    const stored = makeAuth(tokens, { last_refresh: '2026-01-01' });
    const live = makeAuth(tokens, { last_refresh: '2026-02-01' });
    const r = codexAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });

  it('account_id 변경 → stale (다른 계정)', () => {
    const stored = makeAuth({ account_id: 'alice', refresh_token: 'x' });
    const live = makeAuth({ account_id: 'bob', refresh_token: 'y' });
    const r = codexAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('high');
    expect(r.detail).toMatch(/account_id 변경/);
  });

  it('API key 모드 — 동일 키 → fresh, 다른 키 → stale', () => {
    const storedSame = JSON.stringify({ OPENAI_API_KEY: 'sk-same' });
    const liveSame = JSON.stringify({ OPENAI_API_KEY: 'sk-same' });
    expect(codexAdapter.compare(SAVE_AS, storedSame, liveSame).kind).toBe('fresh');

    const liveDiff = JSON.stringify({ OPENAI_API_KEY: 'sk-other' });
    expect(codexAdapter.compare(SAVE_AS, storedSame, liveDiff).kind).toBe('stale');
  });

  it('JSON parse 실패 → rotated both (low)', () => {
    const r = codexAdapter.compare(SAVE_AS, 'not json', '{"tokens":{}}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });

  it('JSON array (object 아님) → rotated both (low) — parseJsonObject 의 array reject 회귀 가드', () => {
    // 옛 local parse 는 typeof === 'object' 만 검사해 array 가 통과됐다.
    // _shared.parseJsonObject 로 마이그레이션 후 array 는 null 반환 → low conf.
    const r = codexAdapter.compare(SAVE_AS, '[]', '{"tokens":{}}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });

  it('미지원 saveAs → low confidence fallback (다른 source 보호)', () => {
    const r = codexAdapter.compare('unknown.json', '{}', '{}');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/미지원 source/);
  });
});
