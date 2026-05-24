import { describe, expect, it } from 'vitest';

import { UsageError, errorMessage, redactMessage } from '../../src/core/errors.js';

describe('UsageError', () => {
  it('exitCode 는 2, name 은 UsageError', () => {
    const err = new UsageError('잘못된 인자');
    expect(err.exitCode).toBe(2);
    expect(err.name).toBe('UsageError');
    expect(err.message).toBe('잘못된 인자');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('redactMessage', () => {
  it('JWT 패턴(eyJ...)을 [redacted-jwt] 로 치환', () => {
    const raw = 'token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig_abcdef';
    const out = redactMessage(raw);
    expect(out).toContain('[redacted-jwt]');
    expect(out).not.toContain('eyJ');
  });

  it('50자 이상 base64-like 시퀀스를 [redacted] 로 치환', () => {
    const long = 'A'.repeat(60);
    const out = redactMessage(`key=${long}`);
    expect(out).toContain('[redacted]');
    expect(out).not.toContain('AAAAA');
  });

  it('49자 이하 base64-like 시퀀스는 보존 (false positive 방지)', () => {
    // 경계 문자로 공백 사용 — `=` 같은 base64 클래스 문자가 앞에 붙으면 길이가 합쳐져 매치된다.
    const short = 'A'.repeat(49);
    const out = redactMessage(`key ${short} end`);
    expect(out).toContain(short);
  });

  it('출력은 500자로 truncate', () => {
    const huge = 'x'.repeat(2000);
    expect(redactMessage(huge).length).toBeLessThanOrEqual(500);
  });

  it('일반 메시지는 변경하지 않는다', () => {
    expect(redactMessage('lock 획득 실패')).toBe('lock 획득 실패');
  });
});

describe('errorMessage', () => {
  it('Error 인스턴스는 .message 추출 + redact 적용', () => {
    const err = new Error('failed with eyJhbGciOiJIUzI1NiJ9.payload.sig_longenoughstring');
    const out = errorMessage(err);
    expect(out).toContain('[redacted-jwt]');
  });

  it('Error 가 아닌 값은 String 변환 + redact 적용', () => {
    expect(errorMessage('plain string')).toBe('plain string');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(null)).toBe('null');
  });

  it('LockHeldError 같은 서브클래스도 .message 만 사용 (스택은 노출 안 함)', () => {
    class CustomErr extends Error {
      constructor(msg: string) { super(msg); this.name = 'CustomErr'; }
    }
    const err = new CustomErr('custom failure');
    expect(errorMessage(err)).toBe('custom failure');
  });
});
