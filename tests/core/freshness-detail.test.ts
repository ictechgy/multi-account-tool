/**
 * freshness detail 이중 문구 — `detail`(영어, --json 계약)과 `localizedDetail`(현재 언어, 표시용).
 */

import { afterEach, describe, expect, it } from 'vitest';

import {
  appendFreshnessDetail,
  displayDetail,
  freshnessDetail,
  freshnessJsonReplacer
} from '../../src/core/freshness-detail.js';
import { setLocale } from '../../src/i18n/index.js';

describe('freshnessDetail', () => {
  afterEach(() => setLocale('ko'));

  it('detail 은 언어 설정과 무관하게 영어, localizedDetail 은 현재 언어', () => {
    setLocale('ko');
    expect(freshnessDetail('liveMissing')).toEqual({
      detail: 'live missing — CLI likely logged out',
      localizedDetail: '라이브 부재 — CLI 로그아웃 추정'
    });
    setLocale('en');
    expect(freshnessDetail('liveMissing')).toEqual({
      detail: 'live missing — CLI likely logged out',
      localizedDetail: 'live missing — CLI likely logged out'
    });
  });

  it('인자를 두 언어에 같은 값으로 넣는다 (마스킹은 호출 전에)', () => {
    setLocale('ko');
    expect(freshnessDetail('keychainAccountChanged', '<hash:aaa>', '<hash:bbb>')).toEqual({
      detail: 'Keychain account changed: <hash:aaa> → <hash:bbb>',
      localizedDetail: 'Keychain account 변경: <hash:aaa> → <hash:bbb>'
    });
  });

  it('appendFreshnessDetail 은 두 언어를 각각 잇고, base 가 비어 있으면 next 만', () => {
    setLocale('ko');
    const base = freshnessDetail('fallbackByteDiff');
    const joined = appendFreshnessDetail(base, freshnessDetail('adapterException', 'boom'), '; ');
    expect(joined.detail).toBe('fallback byte-diff: identity cannot be confirmed — CLI has no adapter; adapter exception: boom');
    expect(joined.localizedDetail).toBe('fallback byte-diff: identity 확정 불가 — adapter 미등록 CLI; adapter 예외: boom');
    expect(appendFreshnessDetail({}, freshnessDetail('nonJson'))).toEqual(freshnessDetail('nonJson'));
  });

  it('표시는 localizedDetail 우선, JSON 은 localizedDetail 을 뺀다', () => {
    setLocale('ko');
    const result = { kind: 'stale', confidence: 'high', ...freshnessDetail('liveMissing') };
    expect(displayDetail(result)).toBe('라이브 부재 — CLI 로그아웃 추정');
    expect(displayDetail({ detail: 'english only' })).toBe('english only');
    const json = JSON.parse(JSON.stringify({ sources: [{ result }] }, freshnessJsonReplacer));
    expect(json.sources[0].result).toEqual({ kind: 'stale', confidence: 'high', detail: 'live missing — CLI likely logged out' });
  });
});
