/**
 * Crush adapter unit tests — pin-backed conservative OAuth freshness (G003).
 *
 * Invariants:
 *  - equal raw bytes → fresh/high
 *  - any changed shape → low-confidence rotated:both unsafe byte-diff
 *  - identity admission is empty → no high-confidence rotation path
 *  - detail never includes fixture token/API-key values
 *  - only crush-config.json / crush-data.json are supported saveAs names
 */

import { describe, expect, it } from 'vitest';

import {
  CRUSH_ADMISSION,
  CRUSH_IDENTITY_FIELDS,
  canConfirmOauthRotation,
  crushAdapter,
  findAdmittedOauthProviders,
  isAdmittedOauthShape
} from '../../../src/core/freshness-adapters/crush.js';

const CONFIG = 'crush-config.json';
const DATA = 'crush-data.json';

/** Synthetic Hyper OAuth object (fixture-safe fake tokens only). */
function hyperOauth(overrides: Partial<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at: number;
}> = {}): Record<string, unknown> {
  return {
    access_token: overrides.access_token ?? 'crushfake-access-0001',
    refresh_token: overrides.refresh_token ?? 'crushfake-refresh-0001',
    expires_in: overrides.expires_in ?? 3600,
    expires_at: overrides.expires_at ?? 1_900_000_000
  };
}

/** Build a root Crush JSON with providers map. */
function crushJson(providers: Record<string, unknown>): string {
  return JSON.stringify({ providers });
}

/** Assert low-confidence unsafe byte-diff transport. */
function expectUnsafeByteDiff(result: ReturnType<typeof crushAdapter.compare>): void {
  expect(result.kind).toBe('rotated');
  expect(result.subtype).toBe('both');
  expect(result.confidence).toBe('low');
  expect(result.detail).toMatch(/identity unknown|conservative byte-diff|unsupported source/i);
  // Affirmative claims only — "no confirmed rotation" is the approved wording.
  expect(result.detail).not.toMatch(/\bsame account\b/i);
  expect(result.detail).not.toMatch(/(?<!\bno\s)confirmed (token )?rotation/i);
  expect(result.detail).not.toMatch(/high-confidence rotation/i);
}

describe('crushAdapter — pin admission', () => {
  it('locks empty identity admission and cannot confirm rotation', () => {
    expect(CRUSH_IDENTITY_FIELDS).toEqual([]);
    expect(CRUSH_ADMISSION.identityFields).toEqual([]);
    expect(canConfirmOauthRotation()).toBe(false);
    expect([...CRUSH_ADMISSION.admittedOauthProviders].sort()).toEqual(['copilot', 'hyper']);
    expect(CRUSH_ADMISSION.oauthRequiredFields).toEqual([
      'access_token',
      'refresh_token',
      'expires_in',
      'expires_at'
    ]);
    expect(CRUSH_ADMISSION.pin).toContain('7b24cc09987337de8bdab1f8b78430efb00337b8');
  });

  it('admits exact four-field OAuth shape and rejects extras/missing/wrong types', () => {
    expect(isAdmittedOauthShape(hyperOauth())).toBe(true);
    expect(isAdmittedOauthShape({ ...hyperOauth(), extra: 'x' })).toBe(false);
    expect(isAdmittedOauthShape({ access_token: 'a', refresh_token: 'b', expires_in: 1 })).toBe(false);
    expect(isAdmittedOauthShape({
      access_token: 'a',
      refresh_token: 'b',
      expires_in: 1.5,
      expires_at: 2
    })).toBe(false);
    expect(isAdmittedOauthShape(null)).toBe(false);
    expect(isAdmittedOauthShape([])).toBe(false);
  });

  it('finds only hyper/copilot admitted OAuth providers (aliases/unknown ignored)', () => {
    const raw = crushJson({
      hyper: { oauth: hyperOauth(), api_key: 'sk-fake-crush-0001' },
      copilot: { oauth: hyperOauth({ access_token: 'crushfake-access-00c1' }) },
      github: { oauth: hyperOauth() },
      custom: { api_key: 'sk-fake-crush-0099' }
    });
    expect(findAdmittedOauthProviders(raw).sort()).toEqual(['copilot', 'hyper']);
  });
});

describe('crushAdapter — equal bytes and token diffs', () => {
  it('byte-identical admitted OAuth+mirrored api_key → fresh high', () => {
    const raw = crushJson({
      hyper: { oauth: hyperOauth(), api_key: 'sk-fake-crush-0001' }
    });
    for (const saveAs of [CONFIG, DATA]) {
      expect(crushAdapter.compare(saveAs, raw, raw)).toEqual({ kind: 'fresh', confidence: 'high' });
    }
  });

  it('byte-identical static-only / malformed still fresh (no live/stored drift)', () => {
    expect(crushAdapter.compare(CONFIG, '{"x":1}', '{"x":1}')).toEqual({
      kind: 'fresh',
      confidence: 'high'
    });
    expect(crushAdapter.compare(DATA, 'not-json', 'not-json')).toEqual({
      kind: 'fresh',
      confidence: 'high'
    });
  });

  it('Hyper token-only diff → low-confidence rotated:both, never high rotation', () => {
    const stored = crushJson({ hyper: { oauth: hyperOauth() } });
    const live = crushJson({
      hyper: { oauth: hyperOauth({ access_token: 'crushfake-access-0002' }) }
    });
    const r = crushAdapter.compare(CONFIG, stored, live);
    expectUnsafeByteDiff(r);
    expect(r.confidence).not.toBe('high');
    expect(r.confidence).not.toBe('medium');
  });

  it('Copilot expiry-only diff → low-confidence rotated:both', () => {
    const stored = crushJson({
      copilot: { oauth: hyperOauth({ expires_at: 1_900_000_000 }) }
    });
    const live = crushJson({
      copilot: { oauth: hyperOauth({ expires_at: 1_900_000_100 }) }
    });
    expectUnsafeByteDiff(crushAdapter.compare(DATA, stored, live));
  });

  it('detail never leaks fixture secret sentinels', () => {
    const sentinelAccess = 'crushfake-access-LEAK';
    const sentinelRefresh = 'crushfake-refresh-LEAK';
    const sentinelKey = 'sk-fake-crush-LEAK';
    const stored = crushJson({
      hyper: {
        oauth: hyperOauth({ access_token: sentinelAccess, refresh_token: sentinelRefresh }),
        api_key: sentinelKey
      }
    });
    const live = crushJson({
      hyper: {
        oauth: hyperOauth({ access_token: 'crushfake-access-NEW', refresh_token: sentinelRefresh }),
        api_key: sentinelKey
      }
    });
    const detail = crushAdapter.compare(CONFIG, stored, live).detail ?? '';
    expect(detail).not.toContain(sentinelAccess);
    expect(detail).not.toContain(sentinelRefresh);
    expect(detail).not.toContain(sentinelKey);
    expect(detail).not.toContain('crushfake-access-NEW');
  });
});

describe('crushAdapter — coexistence / static / malformed matrix', () => {
  it('normal OAuth + mirrored api_key change → low-confidence byte-diff', () => {
    const stored = crushJson({
      hyper: { oauth: hyperOauth(), api_key: 'sk-fake-crush-0001' }
    });
    const live = crushJson({
      hyper: {
        oauth: hyperOauth({ refresh_token: 'crushfake-refresh-0002' }),
        api_key: 'sk-fake-crush-0002'
      }
    });
    expectUnsafeByteDiff(crushAdapter.compare(CONFIG, stored, live));
  });

  it('inconsistent/missing mirrored api_key → low-confidence byte-diff', () => {
    const stored = crushJson({
      hyper: { oauth: hyperOauth(), api_key: 'sk-fake-crush-0001' }
    });
    const live = crushJson({
      hyper: { oauth: hyperOauth() }
    });
    expectUnsafeByteDiff(crushAdapter.compare(DATA, stored, live));
  });

  it('static-only api_key change → low-confidence byte-diff', () => {
    const stored = crushJson({ custom: { api_key: 'sk-fake-crush-0001' } });
    const live = crushJson({ custom: { api_key: 'sk-fake-crush-0002' } });
    expectUnsafeByteDiff(crushAdapter.compare(CONFIG, stored, live));
  });

  it('unknown / alias provider OAuth → low-confidence byte-diff', () => {
    const stored = crushJson({ github: { oauth: hyperOauth() } });
    const live = crushJson({
      github: { oauth: hyperOauth({ access_token: 'crushfake-access-00aa' }) }
    });
    expectUnsafeByteDiff(crushAdapter.compare(CONFIG, stored, live));
  });

  it('provider map add/remove/mismatch → low-confidence byte-diff', () => {
    const stored = crushJson({ hyper: { oauth: hyperOauth() } });
    const live = crushJson({
      hyper: { oauth: hyperOauth() },
      copilot: { oauth: hyperOauth() }
    });
    expectUnsafeByteDiff(crushAdapter.compare(CONFIG, stored, live));

    const removed = crushJson({});
    expectUnsafeByteDiff(crushAdapter.compare(DATA, stored, removed));
  });

  it('malformed root / providers / oauth / wrong types → low-confidence byte-diff', () => {
    const cases: Array<[string, string]> = [
      ['{not json', '{also broken'],
      ['[]', '{}'],
      [JSON.stringify({ providers: [] }), JSON.stringify({ providers: {} })],
      [JSON.stringify({ providers: null }), JSON.stringify({ providers: { hyper: {} } })],
      [
        crushJson({ hyper: { oauth: { access_token: 1, refresh_token: 'x', expires_in: 1, expires_at: 2 } } }),
        crushJson({ hyper: { oauth: hyperOauth() } })
      ],
      [
        crushJson({ hyper: { oauth: { ...hyperOauth(), extra: true } } }),
        crushJson({ hyper: { oauth: hyperOauth() } })
      ]
    ];
    for (const [stored, live] of cases) {
      expectUnsafeByteDiff(crushAdapter.compare(CONFIG, stored, live));
    }
  });

  it('dangerous prototype keys do not become identity or high confidence', () => {
    const storedRaw = '{"providers":{"hyper":{"oauth":' + JSON.stringify(hyperOauth()) +
      '},"__proto__":{"polluted":true}}}';
    const liveRaw = '{"providers":{"hyper":{"oauth":' +
      JSON.stringify(hyperOauth({ access_token: 'crushfake-access-0009' })) +
      '},"constructor":{"polluted":true}}}';

    const parsedStored = JSON.parse(storedRaw);
    expect(Object.prototype.hasOwnProperty.call(parsedStored.providers, '__proto__')).toBe(true);
    const parsedLive = JSON.parse(liveRaw);
    expect(Object.prototype.hasOwnProperty.call(parsedLive.providers, 'constructor')).toBe(true);

    expectUnsafeByteDiff(crushAdapter.compare(CONFIG, storedRaw, liveRaw));
    const probe: Record<string, unknown> = {};
    expect((probe as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it.each([
    { key: '__proto__',   json: '{"access_token":"a","refresh_token":"b","expires_in":1,"expires_at":2,"__proto__":{"x":1}}' },
    { key: 'constructor', json: '{"access_token":"a","refresh_token":"b","expires_in":1,"expires_at":2,"constructor":{}}' },
    { key: 'prototype',   json: '{"access_token":"a","refresh_token":"b","expires_in":1,"expires_at":2,"prototype":{}}' }
  ])('isAdmittedOauthShape rejects OAuth with own "$key" extra key', ({ key, json }) => {
    const poisoned = JSON.parse(json);
    expect(Object.prototype.hasOwnProperty.call(poisoned, key)).toBe(true);
    expect(Object.keys(poisoned).length).toBe(5);
    expect(isAdmittedOauthShape(poisoned)).toBe(false);
  });

  it('findAdmittedOauthProviders excludes dangerous provider keys from traversal', () => {
    const raw =
      '{"providers":{' +
        '"hyper":{"oauth":{"access_token":"a","refresh_token":"b","expires_in":1,"expires_at":2}},' +
        '"__proto__":{"oauth":{"access_token":"c","refresh_token":"d","expires_in":3,"expires_at":4}}' +
      '}}';
    const parsed = JSON.parse(raw);
    expect(Object.prototype.hasOwnProperty.call(parsed.providers, '__proto__')).toBe(true);
    expect(findAdmittedOauthProviders(raw)).toEqual(['hyper']);
  });

  it('unsupported saveAs → low-confidence rotated both', () => {
    const r = crushAdapter.compare('unknown.json', 'a', 'b');
    expectUnsafeByteDiff(r);
    expect(r.detail).toMatch(/unsupported source/);
  });
});
