import { describe, expect, it } from 'vitest';

import { UsageError, ValidationError } from '../../src/core/errors.js';
import {
  validateCliId,
  validateProfileFileName,
  validateProfileName,
  validateSessionId
} from '../../src/core/validators.js';

/**
 * 신규 validators 모듈의 contract 검증.
 *
 * validator 동작 (regex / NFC / traversal / 길이 경계) 자체는 paths.test.ts 가
 * 광범위하게 커버하므로 (BAD_TYPES 매트릭스 + traversal 직접 호출) 여기서는
 * ValidationError instanceof + field 정확성만 확인 — 분리 모듈의 핵심 가치.
 */
describe('validators — ValidationError contract', () => {
  describe('validateCliId', () => {
    it('비문자열 throw 는 ValidationError instance, field === "cliId"', () => {
      try {
        validateCliId(null as unknown as string);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err).toBeInstanceOf(UsageError);
        expect((err as ValidationError).field).toBe('cliId');
        expect((err as ValidationError).exitCode).toBe(2);
      }
    });

    it('traversal 입력 throw 도 field === "cliId"', () => {
      try {
        validateCliId('../escape');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe('cliId');
      }
    });
  });

  describe('validateProfileName', () => {
    it('비문자열 throw 는 field === "profileName"', () => {
      try {
        validateProfileName(undefined as unknown as string);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe('profileName');
      }
    });

    it('예약명 "." throw 도 field === "profileName"', () => {
      try {
        validateProfileName('.');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe('profileName');
      }
    });
  });

  describe('validateProfileFileName', () => {
    it('비문자열 throw 는 field === "profileFileName"', () => {
      try {
        validateProfileFileName(42 as unknown as string);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe('profileFileName');
      }
    });

    it('regex 미매치 throw 도 field === "profileFileName"', () => {
      try {
        validateProfileFileName('한글.json');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect((err as ValidationError).field).toBe('profileFileName');
      }
    });
  });

  describe('정상 입력 — 통과', () => {
    it('validateCliId 정상 입력은 그대로 반환', () => {
      expect(validateCliId('codex')).toBe('codex');
    });

    it('validateProfileName 정상 입력은 NFC 정규화 반환', () => {
      // NFD 입력 → NFC 출력 (위 paths.test.ts 의 매트릭스가 다양 케이스 커버)
      expect(validateProfileName('work')).toBe('work');
    });

    it('validateProfileFileName 정상 입력은 그대로 반환', () => {
      expect(validateProfileFileName('auth.json')).toBe('auth.json');
    });
  });

  describe('validateSessionId (PR-S1)', () => {
    it('정상 입력(영숫자/-/_, 1~64자)은 그대로 반환', () => {
      expect(validateSessionId('codex-work-1a2b3c4d')).toBe('codex-work-1a2b3c4d');
      expect(validateSessionId('a')).toBe('a');
      expect(validateSessionId('A_b-9')).toBe('A_b-9');
      expect(validateSessionId('x'.repeat(64))).toHaveLength(64);
    });

    it('비문자열 throw 는 ValidationError, field === "sessionId"', () => {
      try {
        validateSessionId(null as unknown as string);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ValidationError);
        expect(err).toBeInstanceOf(UsageError);
        expect((err as ValidationError).field).toBe('sessionId');
        expect((err as ValidationError).exitCode).toBe(2);
      }
    });

    it.each(['', 'x'.repeat(65), '.', '..', 'a/b', 'a\\b', 'a b', 'a.b', '세션', 'a\x00b'])(
      'traversal/형식 위반 입력 throw: %j',
      (bad) => {
        expect(() => validateSessionId(bad)).toThrow(ValidationError);
      }
    );
  });
});
