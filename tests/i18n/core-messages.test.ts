/**
 * core 메시지 카탈로그 가드 (i18n 3단계 4단계, #167).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { classifyLssError } from '../../src/core/env-secret-linux-secret-service.js';
import { validateCliId, validateProfileName } from '../../src/core/validators.js';
import { messagesFor, setLocale } from '../../src/i18n/index.js';

const CLASSIFY_KEYWORDS = /ENOENT|daemon|denied|locked|EACCES|cleanup|delete/i;

describe('os-keyring plain Error 문구와 classifyLssError', () => {
  // classifyLssError 는 typed 가 아닌 에러를 이 영문 토큰으로 분류한다. plain Error 로 던지는 문구에
  // 토큰이 섞이면 영어 사용자만 다른 분류를 받는다.
  const en = messagesFor('en').credentials;
  const plainErrorMessages = [
    en.osKeyringInvalidAccount('svc'),
    en.osKeyringParseFailed,
    en.osKeyringBackupCorrupted
  ];

  it.each(plainErrorMessages)('분류 토큰을 포함하지 않는다: %s', (message) => {
    expect(message).not.toMatch(CLASSIFY_KEYWORDS);
    expect(classifyLssError(new Error(message))).toBe('backend-failed');
  });
});

describe('core 메시지는 현재 언어로 나온다', () => {
  afterEach(() => setLocale('ko'));

  it('영어', () => {
    setLocale('en');
    expect(() => validateProfileName('..')).toThrow('"." or ".." cannot be used as a profile name.');
    expect(() => validateCliId('../x')).toThrow(/cannot be used as a path segment/);
  });

  it('한국어 (기존 문구 그대로)', () => {
    setLocale('ko');
    expect(() => validateProfileName('..')).toThrow('"." 또는 ".." 는 프로필 이름으로 사용할 수 없습니다.');
  });
});
