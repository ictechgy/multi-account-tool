/**
 * i18n/locale 순수 함수 단위 테스트 — locale 정규화, 우선순위, `--lang` 추출.
 */

import { describe, expect, it } from 'vitest';

import {
  extractLangFlag,
  normalizeLocale,
  resolveLocale,
  resolveLocaleWithSource,
  systemLocale
} from '../../src/i18n/locale.js';

describe('normalizeLocale', () => {
  it.each([
    ['ko', 'ko'],
    ['KO', 'ko'],
    ['ko-KR', 'ko'],
    ['ko_KR.UTF-8', 'ko'],
    ['en_US.UTF-8', 'en'],
    ['en_GB@euro', 'en'],
    [' en ', 'en']
  ])('%s → %s', (raw, expected) => {
    expect(normalizeLocale(raw)).toBe(expected);
  });

  it.each(['', 'C', 'POSIX', 'C.UTF-8', 'fr_FR.UTF-8', 'korean'])('%s → undefined', (raw) => {
    expect(normalizeLocale(raw)).toBeUndefined();
  });

  it('undefined/null → undefined', () => {
    expect(normalizeLocale(undefined)).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });
});

describe('systemLocale', () => {
  it('LC_ALL > LC_MESSAGES > LANG', () => {
    expect(systemLocale({ LC_ALL: 'ko_KR.UTF-8', LC_MESSAGES: 'en_US', LANG: 'en_US' })).toBe('ko');
    expect(systemLocale({ LC_MESSAGES: 'ko_KR.UTF-8', LANG: 'en_US' })).toBe('ko');
    expect(systemLocale({ LANG: 'ko_KR.UTF-8' })).toBe('ko');
  });

  it('빈 값은 건너뛴다', () => {
    expect(systemLocale({ LC_ALL: '', LANG: 'ko_KR.UTF-8' })).toBe('ko');
  });

  it('결정권 있는 값이 미지원이면 뒤 변수로 넘어가지 않고 en', () => {
    expect(systemLocale({ LC_ALL: 'C', LANG: 'ko_KR.UTF-8' })).toBe('en');
    expect(systemLocale({ LANG: 'fr_FR.UTF-8' })).toBe('en');
  });

  it('아무것도 없으면 en', () => {
    expect(systemLocale({})).toBe('en');
  });
});

describe('resolveLocale 우선순위', () => {
  const env = { MAT_LANG: 'ko', LANG: 'en_US.UTF-8' };

  it('--lang 이 최우선', () => {
    expect(resolveLocale({ flag: 'en', env, configLanguage: 'ko' })).toBe('en');
  });

  it('MAT_LANG 이 config 보다 우선', () => {
    expect(resolveLocale({ env: { MAT_LANG: 'en', LANG: 'ko_KR.UTF-8' }, configLanguage: 'ko' })).toBe('en');
  });

  it('config 가 시스템 locale 보다 우선', () => {
    expect(resolveLocale({ env: { LANG: 'en_US.UTF-8' }, configLanguage: 'ko' })).toBe('ko');
  });

  it('인식 불가 MAT_LANG/config 는 무시하고 다음 단계로', () => {
    expect(resolveLocale({ env: { MAT_LANG: 'fr', LANG: 'ko_KR.UTF-8' }, configLanguage: 'xx' })).toBe('ko');
  });

  it('모두 없으면 en', () => {
    expect(resolveLocale({ env: {} })).toBe('en');
  });
});

describe('resolveLocaleWithSource', () => {
  it('결정한 단계를 함께 돌려준다 (system 이면 사용자가 고른 적 없음 → TUI 가 묻는다)', () => {
    expect(resolveLocaleWithSource({ flag: 'ko', env: {} })).toEqual({ locale: 'ko', source: 'flag' });
    expect(resolveLocaleWithSource({ env: { MAT_LANG: 'en' } })).toEqual({ locale: 'en', source: 'env' });
    expect(resolveLocaleWithSource({ env: {}, configLanguage: 'ko' })).toEqual({ locale: 'ko', source: 'config' });
    expect(resolveLocaleWithSource({ env: { LANG: 'ko_KR.UTF-8' } })).toEqual({ locale: 'ko', source: 'system' });
  });

  it('인식 불가 config 값은 고른 것으로 치지 않는다', () => {
    expect(resolveLocaleWithSource({ env: {}, configLanguage: 'xx' }).source).toBe('system');
  });
});

describe('extractLangFlag', () => {
  it('--lang <v> 를 떼어낸다', () => {
    expect(extractLangFlag(['--lang', 'en', 'status', '--json'])).toEqual({ ok: true, lang: 'en', rest: ['status', '--json'] });
  });

  it('--lang=<v> 형식', () => {
    expect(extractLangFlag(['--lang=ko', 'doctor'])).toEqual({ ok: true, lang: 'ko', rest: ['doctor'] });
  });

  it('값 없는 --lang 은 실패', () => {
    expect(extractLangFlag(['--lang'])).toEqual({ ok: false, rest: [] });
  });

  it('선두가 아닌 --lang 은 건드리지 않는다 (자식 명령 인자 보존)', () => {
    const args = ['exec', 'codex', 'work', '--', 'tool', '--lang', 'fr'];
    expect(extractLangFlag(args)).toEqual({ ok: true, rest: args });
  });

  it('인자 없음', () => {
    expect(extractLangFlag([])).toEqual({ ok: true, rest: [] });
  });
});
