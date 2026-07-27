/**
 * `formatSwitchResult` 전용 테스트.
 *
 * 0.8.1 까지 이 함수에는 전용 테스트가 없었고 통합 테스트에서 간접 검증만 됐다. carry-over
 * 안내는 자격증명 도구의 **사용자 대면 안전 문구**라 문구가 틀리면 사용자가 다른 계정의
 * 자격증명을 저장하게 된다 — 실제로 v0.8.1 리뷰 루프에서 그 결함이 두 번 나왔다.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { formatSwitchResult } from '../../src/app/formatters.js';
import type { SwitchResult } from '../../src/core/switcher.js';

const result = (restore: Partial<SwitchResult['restore']>): SwitchResult => ({
  fromSnapshot: undefined,
  preSwapLiveFreshness: undefined,
  restore: {
    cliId: 'goose',
    profileName: 'acct-a',
    restored: [],
    missing: [],
    carriedOver: [],
    carryOverEvaluated: true,
    ...restore
  }
});

describe('formatSwitchResult — carry-over 판정 여부', () => {
  it('판정하지 않은 경우 오도적인 "0개 파일" 줄을 대체하고 그 사실을 명시한다', () => {
    const text = formatSwitchResult(result({ carryOverEvaluated: false }), 'acct-a');
    // "복원 → X : 0개 파일" 은 "복원을 시도했는데 0개" 로 읽힌다. 실제로는 복원 자체를 안 했다.
    expect(text).not.toMatch(/복원 → .* : 0개 파일/);
    expect(text).toMatch(/복원을 수행하지 않았습니다/);
    expect(text).toMatch(/이월 여부를 판정하지 않았습니다/);
    expect(text).toMatch(/mat doctor/);
  });

  it('판정했고 이월이 없으면 경고를 내지 않는다 (기존 동작 보존)', () => {
    const text = formatSwitchResult(result({ restored: ['a.json'], carryOverEvaluated: true }), 'acct-a');
    expect(text).toMatch(/복원 → acct-a : 1개 파일/);
    expect(text).not.toMatch(/이전 계정 자격증명/);
    expect(text).not.toMatch(/판정하지 않았습니다/);
  });

  it('이월이 있으면 재캡처를 만류하고 순서 조건을 안내한다', () => {
    const text = formatSwitchResult(
      result({ missing: ['goose-provider-gemini-oauth-tokens.json'], carriedOver: ['goose-provider-gemini-oauth-tokens.json'] }),
      'acct-a'
    );
    expect(text).toMatch(/이전 계정 자격증명이 라이브에 그대로 남아 있습니다/);
    // 지금 재캡처하면 직전 계정 자격증명을 이 프로필에 저장하게 된다 — 반드시 만류해야 한다.
    expect(text).toMatch(/재캡처하지 마세요/);
    // 다만 절대 금지가 아니라 순서 조건임도 밝혀야 한다.
    expect(text).toMatch(/다시 로그인한 뒤에는 .* 재캡처가 올바른 조치/);
    expect(text).toMatch(/mat freshness/);
    // 사용자가 라이브 값의 주인을 모르는 상태에서 다른 프로필을 오염시키게 유도하면 안 된다.
    expect(text).not.toMatch(/그 프로필을 먼저 재캡처/);
  });

  it('중립 skip 라인과 이월 경고는 서로 구별되는 별도 라인이다', () => {
    const text = formatSwitchResult(
      result({ missing: ['a.json', 'b.json'], carriedOver: ['b.json'] }),
      'acct-a'
    );
    expect(text).toMatch(/프로필에 없어 건너뜀: a\.json, b\.json/);
    expect(text).toMatch(/⚠ 이전 계정 자격증명이 라이브에 그대로 남아 있습니다: b\.json/);
  });
});

describe('carriedOver 읽기는 carryOverEvaluated 게이트 아래에 있어야 한다', () => {
  it('src 안의 모든 .carriedOver 참조가 평가 여부 확인 뒤에 온다', () => {
    // 타입이 강제하지 못하는 부분을 관례로 고정한다. `carryOverEvaluated` 가 false 인데
    // `carriedOver` 를 읽으면 "이월 없음" 으로 오독하게 된다.
    const src = readFileSync(new URL('../../src/app/formatters.ts', import.meta.url), 'utf8');
    const guardIndex = src.indexOf('carryOverEvaluated');
    const readIndex = src.indexOf('restore.carriedOver');
    expect(guardIndex).toBeGreaterThan(-1);
    expect(readIndex).toBeGreaterThan(guardIndex);
  });
});
