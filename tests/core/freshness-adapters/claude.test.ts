/**
 * Claude adapter 단위 테스트 — `Claude Code-credentials` (macOS keychain) 또는
 * `~/.claude/.credentials.json` (비-macOS file) 의 identity-aware 비교.
 *
 * 핵심 invariant:
 *  - byte-identical → fresh (high)
 *  - KeychainStored.account 변경 → stale (high) — macOS keychain account 안전망
 *  - claudeAiOauth.subscriptionType 변경 → stale (medium) — 다른 plan/계정 추정
 *  - subscriptionType 동일 + token 변경 → rotated value-only (high)
 *  - token 동일 + expiresAt 만 변경 → rotated meta-only (high)
 *  - claudeAiOauth 부재 → rotated both (low) — API key 모드 또는 손상
 *  - JSON parse 실패 → rotated both (low)
 *  - 미지원 saveAs → low confidence fallback
 *  - raw credentials (non-macOS file source) 도 정상 처리
 */

import { describe, expect, it } from 'vitest';

import { claudeAdapter } from '../../../src/core/freshness-adapters/claude.js';

const SAVE_AS = 'credentials.json';

/** raw credentials.json (non-macOS file source) 페이로드. */
function makeCreds(oauth: Partial<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType: string;
}>): string {
  return JSON.stringify({ claudeAiOauth: oauth });
}

/** KeychainStored wrapper (macOS keychain source). */
function makeWrapped(inner: string, account?: string): string {
  return JSON.stringify(account !== undefined ? { value: inner, account } : { value: inner });
}

describe('claudeAdapter — identity-aware 비교', () => {
  it('byte-identical → fresh (high)', () => {
    const raw = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r' });
    expect(claudeAdapter.compare(SAVE_AS, raw, raw)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('raw credentials (non-macOS file source) — subscriptionType 동일 + token 변경 → rotated value-only (high)', () => {
    const stored = makeCreds({ subscriptionType: 'pro', accessToken: 'old', refreshToken: 'oldR' });
    const live = makeCreds({ subscriptionType: 'pro', accessToken: 'new', refreshToken: 'newR' });
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('high');
  });

  it('token 동일 + expiresAt 만 변경 → rotated meta-only (high)', () => {
    const stored = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r', expiresAt: 100 });
    const live = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r', expiresAt: 200 });
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('meta-only');
    expect(r.confidence).toBe('high');
  });

  it('subscriptionType 변경 → stale (medium) — 다른 plan/계정 추정', () => {
    const stored = makeCreds({ subscriptionType: 'pro', accessToken: 'a' });
    const live = makeCreds({ subscriptionType: 'enterprise', accessToken: 'a' });
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('medium');
    expect(r.detail).toMatch(/subscriptionType/);
  });

  it('KeychainStored.account 변경 → stale (high) — macOS keychain user 변경', () => {
    // 동일 credentials 인데 macOS keychain account 만 다르다 = 다른 사용자.
    const inner = makeCreds({ subscriptionType: 'pro', accessToken: 'a' });
    const stored = makeWrapped(inner, 'alice');
    const live = makeWrapped(inner, 'bob');
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('high');
    expect(r.detail).toMatch(/Keychain account 변경/);
  });

  it('KeychainStored wrapper + 동일 account + token rotation → rotated value-only', () => {
    // 정상 rotation 시나리오: 같은 macOS user, OAuth token 만 갱신.
    const oldInner = makeCreds({ subscriptionType: 'pro', accessToken: 'old', refreshToken: 'oldR' });
    const newInner = makeCreds({ subscriptionType: 'pro', accessToken: 'new', refreshToken: 'newR' });
    const stored = makeWrapped(oldInner, 'user1');
    const live = makeWrapped(newInner, 'user1');
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('claudeAiOauth 필드 부재 (API key 모드 등) → rotated both (low)', () => {
    const stored = JSON.stringify({ other: 'data' });
    const live = JSON.stringify({ other: 'changed' });
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/claudeAiOauth 필드 부재/);
  });

  it('JSON parse 실패 → rotated both (low) — 손상 detail', () => {
    const r = claudeAdapter.compare(SAVE_AS, '{not json', 'also not json');
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/parse 실패/);
  });

  it('미지원 saveAs → low confidence fallback', () => {
    const r = claudeAdapter.compare('other.json', '{}', '{}');
    expect(r.kind).toBe('rotated');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/미지원 source/);
  });

  it('기타 OAuth 필드만 변경 (scopes 추가) → rotated both (medium)', () => {
    const stored = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r', expiresAt: 100, scopes: ['read'] });
    const live = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r', expiresAt: 100, scopes: ['read', 'write'] });
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('medium');
  });
});

describe('claudeAdapter — quad-review iter 1 HIGH fix (H3/H4/H5)', () => {
  it('H3: subscriptionType XOR (한쪽만 string) → stale (low) — identity 우회 차단', () => {
    // 공격/손상 시나리오: stored 에서 subscriptionType 만 제거 → token 비교로 떨어져
    // value-only rotated high 로 잘못 분류. fix 후: XOR → stale low.
    const stored = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r' });
    const live = makeCreds({ accessToken: 'b', refreshToken: 's' });  // subscriptionType 누락
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/subscriptionType 비대칭/);
  });

  it('H4: KeychainStored account XOR (한쪽만 account) → stale (low) — wrapper 손상 추정', () => {
    // 한쪽 wrapper 에만 account 있는 경우 silent skip 하면 multi-account 보호 우회.
    const inner = makeCreds({ subscriptionType: 'pro', accessToken: 'a' });
    const stored = makeWrapped(inner, 'alice');  // account 있음
    const live = makeWrapped(inner);              // account 없음 (wrapper 만)
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/account 비대칭/);
  });

  it('H4: wrapper 형태 자체가 비대칭 (한쪽만 wrapper) → stale (low)', () => {
    // stored 는 KeychainStored wrapper, live 는 raw credentials → 비대칭 분기.
    const inner = makeCreds({ subscriptionType: 'pro', accessToken: 'a' });
    const stored = makeWrapped(inner, 'user');
    const live = inner;  // raw credentials (wrapper 없음)
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/wrapper 비대칭/);
  });

  it('H5: OAuth token 양쪽 모두 부재 → rotated both (low) — 손상 추정', () => {
    // claudeAiOauth 객체는 있지만 access/refresh 모두 없는 손상 케이스.
    // expiresAt 만 비교하면 meta-only 로 잘못 분류 가능. fix 후 low-conf both.
    const stored = JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro', expiresAt: 100 } });
    const live = JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro', expiresAt: 200 } });
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/OAuth token 양쪽 모두 부재/);
  });

  it('H5: stored 에 token 있음 + live 에 token 부재 → rotated value-only (high) — 정상 분류 유지', () => {
    // 한쪽만 token 부재는 XOR 차이 → token 변경으로 value-only 분류 (정상).
    // 양쪽 모두 부재 시만 low-conf 분기 활성화.
    const stored = makeCreds({ subscriptionType: 'pro', accessToken: 'a', refreshToken: 'r' });
    const live = JSON.stringify({ claudeAiOauth: { subscriptionType: 'pro' } });  // token 부재
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('iter 2 Codex-3 #3 fix: empty-string account `""` 도 유효 string — XOR truthiness 우회 차단', () => {
    // 이전 truthiness 는 '' && ... 가 false 라 empty string account 를 absent 로
    // 잘못 분류 → XOR 분기 우회 가능. typeof === 'string' 정밀화 후 동작 검증.
    //
    // 동일 inner credentials + 양쪽 모두 empty string account → 동일성 인정 (fresh).
    const inner = makeCreds({ subscriptionType: 'pro', accessToken: 'a' });
    const stored = makeWrapped(inner, '');
    const live = makeWrapped(inner, '');
    expect(claudeAdapter.compare(SAVE_AS, stored, live)).toEqual({ kind: 'fresh', confidence: 'high' });
  });

  it('iter 2 Codex-3 #3 fix: empty-string vs non-empty account → stale high (다름 검출)', () => {
    // '' 와 'user' 가 다르다는 사실이 typeof 검사 후에 정확히 stale 분류.
    const inner = makeCreds({ subscriptionType: 'pro', accessToken: 'a' });
    const stored = makeWrapped(inner, '');
    const live = makeWrapped(inner, 'user');
    const r = claudeAdapter.compare(SAVE_AS, stored, live);
    expect(r.kind).toBe('stale');
    expect(r.confidence).toBe('high');
    expect(r.detail).toMatch(/Keychain account 변경/);
  });
});
