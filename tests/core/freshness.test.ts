/**
 * freshness 모듈 단위 테스트.
 *
 * 검증 매트릭스:
 *  - CompareResult 4-state (fresh / rotated / stale / inflight) — fallback 경로
 *  - rotation 화이트리스트 normalize (refresh_token / access_token 등만 비교, 캐시 필드 무시)
 *  - adapter registry (register/reset/get) idempotency
 *  - inspectLiveFreshness 의 source 별 누락 케이스 (양쪽 부재/라이브 부재/저장본 부재)
 *  - adapter 예외 swallow → fallback 대체
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fallbackCompare,
  getAdapter,
  hasInflight,
  inspectLiveFreshness,
  needsUserAttention,
  registerAdapter,
  resetAdapters,
  type CompareResult,
  type FreshnessReport,
  type SourceAdapter
} from '../../src/core/freshness.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('fallbackCompare — prototype pollution 방어 (quad-review HIGH fix)', () => {
  it('__proto__ 키 포함 JSON → normalize 결과에 영향 없음 (prototype 미오염)', () => {
    // Before fix: __proto__ 키가 normalize 결과 객체의 prototype 을 오염 가능 → compare bypass.
    // After fix: DANGEROUS_KEYS skip + Object.create(null) — 결과에 미포함.
    const stored = JSON.stringify({ refresh_token: 'r1', __proto__: { refresh_token: 'evil' } });
    const live = JSON.stringify({ refresh_token: 'r2', __proto__: { refresh_token: 'evil' } });
    const r = fallbackCompare(stored, live);
    // 실제 refresh_token 만 비교됨 → 다르므로 rotated.
    expect(r.kind).toBe('rotated');
    expect(({} as Record<string, unknown>).refresh_token).toBeUndefined();
  });

  it('constructor 키 포함 → 정상 normalize, 결과 객체 prototype 비오염', () => {
    const stored = JSON.stringify({ access_token: 'a', constructor: { x: 1 } });
    const live = JSON.stringify({ access_token: 'a', constructor: { x: 2 } });
    // constructor 는 DANGEROUS_KEYS → drop. 화이트리스트 외 필드만 변경 → fresh medium.
    const r = fallbackCompare(stored, live);
    expect(r.kind).toBe('fresh');
  });
});

describe('fallbackCompare — empty normalize bypass 차단 (quad-review HIGH fix)', () => {
  it('양쪽 모두 화이트리스트 필드 부재 (예: {apiKey:...}) → fresh 거부 → rotated/both low', () => {
    // Before fix: normalize 양쪽 {} → equal → fresh 처리 → 실제 자격증명 변경 누락.
    // After fix: empty normalize 는 fresh 아닌 low-conf rotated/both.
    const stored = JSON.stringify({ apiKey: 'sk-old' });
    const live = JSON.stringify({ apiKey: 'sk-new' });
    const r = fallbackCompare(stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
    expect(r.detail).toMatch(/adapter 추가 권장/);
  });
});

describe('fallbackCompare — adapter 미정의 CLI 용 byte-diff', () => {
  it('byte-identical → fresh (high)', () => {
    const r = fallbackCompare('{"x":1}', '{"x":1}');
    expect(r.kind).toBe('fresh');
    expect(r.confidence).toBe('high');
  });

  it('회전 후보 필드 변경 → rotated value-only (low confidence — identity 미검증)', () => {
    const stored = JSON.stringify({ refresh_token: 'old', expiry: 123 });
    const live = JSON.stringify({ refresh_token: 'new', expiry: 123 });
    const r = fallbackCompare(stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
    expect(r.confidence).toBe('low');
  });

  it('회전 후보 필드 동일 + 캐시 필드만 변경 → fresh (medium) — dialog false-positive 차단', () => {
    // quad-review MEDIUM fix: 사용자 자격증명 자체는 변경 없으므로 fresh 분류.
    // PR-G dialog 가 'rotated' 만 보고 띄우면 정상 사용 noise 까지 잡혀 사용자 피로 발생.
    const stored = JSON.stringify({ refresh_token: 'same', last_refresh: 'a' });
    const live = JSON.stringify({ refresh_token: 'same', last_refresh: 'b' });
    const r = fallbackCompare(stored, live);
    expect(r.kind).toBe('fresh');
    expect(r.confidence).toBe('medium');
    expect(r.detail).toMatch(/회전 후보 필드 동일/);
  });

  it('JSON 아님 → rotated both (low, byte 비교만)', () => {
    const r = fallbackCompare('not json', 'also not json');
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('both');
    expect(r.confidence).toBe('low');
  });

  it('중첩 객체에서도 회전 후보 필드만 비교', () => {
    // openai.refresh 만 변경, openai.expires 는 캐시 (무시)
    const stored = JSON.stringify({ openai: { refresh: 'old', expires: 1 } });
    const live = JSON.stringify({ openai: { refresh: 'new', expires: 2 } });
    const r = fallbackCompare(stored, live);
    expect(r.kind).toBe('rotated');
    expect(r.subtype).toBe('value-only');
  });

  it('중첩 객체의 회전 후보 동일 + 캐시 필드만 변경 → fresh (medium)', () => {
    // quad-review MEDIUM fix: nested 도 동일 — refresh 가 같으면 fresh.
    const stored = JSON.stringify({ openai: { refresh: 'same', expires: 1 } });
    const live = JSON.stringify({ openai: { refresh: 'same', expires: 2 } });
    const r = fallbackCompare(stored, live);
    expect(r.kind).toBe('fresh');
    expect(r.confidence).toBe('medium');
  });
});

describe('adapter registry — register/get/reset', () => {
  afterEach(() => {
    resetAdapters();
  });

  it('등록 후 getAdapter 가 동일 인스턴스 반환', () => {
    const adapter: SourceAdapter = {
      compare: (): CompareResult => ({ kind: 'fresh', confidence: 'high' })
    };
    registerAdapter('test-cli', adapter);
    expect(getAdapter('test-cli')).toBe(adapter);
  });

  it('resetAdapters 후 getAdapter 가 undefined', () => {
    registerAdapter('test-cli', { compare: () => ({ kind: 'fresh', confidence: 'high' }) });
    resetAdapters();
    expect(getAdapter('test-cli')).toBeUndefined();
  });

  it('동일 cliId 재등록 시 마지막 adapter 채택', () => {
    const a1: SourceAdapter = { compare: () => ({ kind: 'fresh', confidence: 'high' }) };
    const a2: SourceAdapter = { compare: () => ({ kind: 'stale', confidence: 'high' }) };
    registerAdapter('x', a1);
    registerAdapter('x', a2);
    expect(getAdapter('x')).toBe(a2);
  });
});

describe('inspectLiveFreshness — fs 통합 (claude 외 file source 기반)', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetAdapters();
  });

  afterEach(async () => {
    resetAdapters();
    await tmp.cleanup();
  });

  /**
   * 라이브 + 저장본 양쪽 부재 → fresh (변경 없음).
   *
   * Codex 의 `auth.json` 이 양쪽 모두 없으면 swap 의미 없음 — fresh 보고로 dialog 안 뜨게 함.
   */
  it('양쪽 부재 → fresh (swap 무관)', async () => {
    // Codex builtin: ~/.codex/auth.json — 둘 다 없음
    await fs.mkdir(join(tmp.home, '.multi-account-tool/profiles/codex/personal'), { recursive: true });
    const report = await inspectLiveFreshness('codex', 'personal');
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0].result.kind).toBe('fresh');
    expect(report.sources[0].result.detail).toMatch(/양쪽 부재/);
  });

  it('라이브 부재 (저장본 존재) → stale', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/personal');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'auth.json'), '{"tokens":{}}');
    // 라이브는 ~/.codex/auth.json — 부재
    const report = await inspectLiveFreshness('codex', 'personal');
    expect(report.sources[0].result.kind).toBe('stale');
    expect(report.sources[0].result.detail).toMatch(/라이브 부재/);
  });

  it('저장본 부재 (라이브 존재) → stale', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/personal');
    await fs.mkdir(profileDir, { recursive: true });
    // meta.json 만 있고 auth.json 미저장
    await fs.writeFile(join(profileDir, 'meta.json'), '{}');
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex/auth.json'), '{"tokens":{}}');
    const report = await inspectLiveFreshness('codex', 'personal');
    expect(report.sources[0].result.kind).toBe('stale');
    expect(report.sources[0].result.detail).toMatch(/저장본 부재/);
  });

  it('알 수 없는 cliId → UnknownCliError throw (UsageError 상속, exit 2 자동 매핑)', async () => {
    // quad-review MED fix: 이전엔 Error("알 수 없는 CLI: ...") throw → caller 가 message
    // 정규식 매칭으로 분기 (brittle). 새 정책: 전용 클래스 + UsageError 상속 → instanceof.
    const { UnknownCliError, UsageError } = await import('../../src/core/errors.js');
    let caught: unknown;
    try {
      await inspectLiveFreshness('does-not-exist', 'p');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UnknownCliError);
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as { exitCode: number }).exitCode).toBe(2);
    expect((caught as { cliId: string }).cliId).toBe('does-not-exist');
  });

  it('adapter 등록 시 fallback 대신 adapter.compare 호출', async () => {
    const adapter: SourceAdapter = {
      compare: vi.fn(() => ({ kind: 'rotated', subtype: 'value-only', confidence: 'high' }))
    };
    registerAdapter('codex', adapter);
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'auth.json'), '{"v":1}');
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex/auth.json'), '{"v":2}');

    const report = await inspectLiveFreshness('codex', 'p');
    expect(adapter.compare).toHaveBeenCalledWith('auth.json', '{"v":1}', '{"v":2}');
    expect(report.sources[0].result.kind).toBe('rotated');
  });

  it('adapter 예외 → fallbackCompare 호출 결과 + adapter 예외 detail 첨부 (quad-review MED fix)', async () => {
    // Before fix: catch 가 generic rotated/both 만 반환 → fallback 비교 자체 미실행.
    // After fix: fallbackCompare 호출 → 정상 분류 + detail 에 adapter 예외 append.
    const adapter: SourceAdapter = {
      compare: () => {
        throw new Error('adapter boom');
      }
    };
    registerAdapter('codex', adapter);
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/codex/p');
    await fs.mkdir(profileDir, { recursive: true });
    // 양쪽 동일 — fallback 이 fresh 분류해야 함 (이전엔 rotated/both 가 잘못 반환됨).
    await fs.writeFile(join(profileDir, 'auth.json'), '{"refresh_token":"same"}');
    await fs.mkdir(join(tmp.home, '.codex'), { recursive: true });
    await fs.writeFile(join(tmp.home, '.codex/auth.json'), '{"refresh_token":"same"}');

    const report = await inspectLiveFreshness('codex', 'p');
    expect(report.sources[0].result.kind).toBe('fresh');  // fallback 정상 분류
    expect(report.sources[0].result.detail).toMatch(/adapter 예외: adapter boom/);
  });

  it('multi-source CLI (Gemini) — source 별 결과 독립 보고', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool/profiles/gemini/p');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(join(profileDir, 'oauth_creds.json'), '{"a":1}');
    await fs.writeFile(join(profileDir, 'google_accounts.json'), '{"active":"x"}');
    // 라이브 양쪽 부재
    const report = await inspectLiveFreshness('gemini', 'p');
    expect(report.sources).toHaveLength(2);
    expect(report.sources[0].saveAs).toBe('oauth_creds.json');
    expect(report.sources[1].saveAs).toBe('google_accounts.json');
    // 둘 다 라이브 부재 + 저장본 존재 → stale
    expect(report.sources[0].result.kind).toBe('stale');
    expect(report.sources[1].result.kind).toBe('stale');
  });
});

// --- PR-G: TUI dialog 분기 predicate ---

/**
 * 합성된 FreshnessReport 헬퍼. inspectLiveFreshness 의 fs 의존 없이 predicate
 * 단위 검증 — 입력 매트릭스만 표현.
 */
function makeReport(kinds: CompareResult['kind'][]): FreshnessReport {
  return {
    cliId: 'codex',
    profileName: 'work',
    sources: kinds.map((kind, i) => ({
      saveAs: `s${i}.json`,
      result: { kind, confidence: 'high' as const }
    }))
  };
}

describe('needsUserAttention (PR-G)', () => {
  it('모든 source fresh → false (dialog 미표시)', () => {
    expect(needsUserAttention(makeReport(['fresh']))).toBe(false);
    expect(needsUserAttention(makeReport(['fresh', 'fresh']))).toBe(false);
  });

  it('rotated 하나라도 → true', () => {
    expect(needsUserAttention(makeReport(['rotated']))).toBe(true);
    expect(needsUserAttention(makeReport(['fresh', 'rotated']))).toBe(true);
  });

  it('stale 하나라도 → true', () => {
    expect(needsUserAttention(makeReport(['stale']))).toBe(true);
    expect(needsUserAttention(makeReport(['fresh', 'stale']))).toBe(true);
  });

  it('inflight 하나라도 → true (재시도 안내 톤은 hasInflight 로 분기)', () => {
    expect(needsUserAttention(makeReport(['inflight']))).toBe(true);
  });

  it('빈 sources → false (보고할 source 없음 — dialog 의미 없음)', () => {
    expect(needsUserAttention(makeReport([]))).toBe(false);
  });
});

describe('hasInflight (PR-G)', () => {
  it('inflight 하나라도 → true', () => {
    expect(hasInflight(makeReport(['inflight']))).toBe(true);
    expect(hasInflight(makeReport(['fresh', 'rotated', 'inflight']))).toBe(true);
  });

  it('inflight 없음 → false (rotated/stale 만 있어도)', () => {
    expect(hasInflight(makeReport(['rotated', 'stale']))).toBe(false);
    expect(hasInflight(makeReport(['fresh']))).toBe(false);
  });
});
