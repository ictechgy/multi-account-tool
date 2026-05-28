/**
 * Gemini adapter 단위 테스트.
 *
 * 두 source 분기:
 *  - oauth_creds.json: token 동일/변경, parse 실패
 *  - google_accounts.json: active 동일/변경 → stale, parse 실패
 *  - 미지원 saveAs → low confidence fallback
 */

import { describe, expect, it } from 'vitest';

import { geminiAdapter } from '../../../src/core/freshness-adapters/gemini.js';

describe('geminiAdapter — oauth_creds.json', () => {
  const SAVE_AS = 'oauth_creds.json';

  it('byte-identical → fresh', () => {
    const raw = JSON.stringify({ refresh_token: 'r', access_token: 'a' });
    expect(geminiAdapter.compare(SAVE_AS, raw, raw)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('token 변경 → rotated value-only', () => {
    const stored = JSON.stringify({ refresh_token: 'old', access_token: 'oa', expiry_date: 1 });
    const live = JSON.stringify({ refresh_token: 'new', access_token: 'na', expiry_date: 2 });
    const r = geminiAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('token 동일 + expiry_date 만 변경 → rotated meta-only', () => {
    const stored = JSON.stringify({ refresh_token: 'r', access_token: 'a', expiry_date: 1 });
    const live = JSON.stringify({ refresh_token: 'r', access_token: 'a', expiry_date: 2 });
    const r = geminiAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });

  it('parse 실패 → rotated both (low)', () => {
    const r = geminiAdapter.compare(SAVE_AS, 'not json', '{"refresh_token":"x"}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
  });

  it('JSON array → rotated both (low) — _shared.parseJsonObject array reject 회귀 가드', () => {
    const r = geminiAdapter.compare(SAVE_AS, '[]', '{"refresh_token":"x"}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });
});

describe('geminiAdapter — google_accounts.json', () => {
  const SAVE_AS = 'google_accounts.json';

  it('active 동일 → meta-only (old 목록만 변경)', () => {
    const stored = JSON.stringify({ active: 'user@example.com', old: [] });
    const live = JSON.stringify({ active: 'user@example.com', old: ['prev@example.com'] });
    const r = geminiAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
  });

  it('active 변경 → stale + detail 의 email PII 마스킹 (quad-review MED fix)', () => {
    // detail 에 raw email 노출되면 CI 로그/shell history 누설 — maskIdentifier 적용 후엔
    // <hash:...> 형식만, 원본 email 부재.
    const stored = JSON.stringify({ active: 'alice@example.com' });
    const live = JSON.stringify({ active: 'bob@example.com' });
    const r = geminiAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.detail).toMatch(/active 계정 변경/);
    expect(r.detail).not.toContain('alice');
    expect(r.detail).not.toContain('bob');
    expect(r.detail).not.toContain('example.com');
    expect(r.detail).toMatch(/<hash:[0-9a-f]{8}>/);
  });

  it('active 필드 부재 → medium confidence rotated', () => {
    const r = geminiAdapter.compare(SAVE_AS, '{}', '{"old":[]}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('medium');
    expect(r.detail).toMatch(/active 필드 부재/);
  });

  it('byte-identical → fresh', () => {
    const raw = JSON.stringify({ active: 'a@example.com' });
    expect(geminiAdapter.compare(SAVE_AS, raw, raw)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('JSON array → rotated both (low) — _shared.parseJsonObject array reject 대칭 가드', () => {
    const r = geminiAdapter.compare(SAVE_AS, '[]', '{"active":"a@example.com"}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });
});

describe('geminiAdapter — 미지원 saveAs', () => {
  it('low confidence fallback', () => {
    const r = geminiAdapter.compare('unknown.json', '{}', '{}');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/미지원 source/);
  });
});
