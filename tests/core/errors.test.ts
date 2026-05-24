import { describe, expect, it } from 'vitest';

import { KeychainAccountMissingError, UsageError, describeError, errorMessage, redactMessage } from '../../src/core/errors.js';

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

  it('redact 가 truncate 보다 먼저 적용된다 (회귀 가드)', () => {
    // 순서가 뒤바뀌면 500자 잘림 후 redact 가 끊긴 JWT/시크릿 시퀀스를 놓칠 수 있다.
    // 앞쪽 400자를 안전 패딩으로 채우고 그 뒤에 JWT 를 둬, truncate 가 먼저면 JWT 가 살아남는 케이스를 만든다.
    const padding = '가'.repeat(400);
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature_data_block';
    const out = redactMessage(`${padding} token=${jwt}`);
    expect(out).not.toContain('eyJ');
    expect(out).toContain('[redacted-jwt]');
  });

  it('일반 메시지는 변경하지 않는다', () => {
    expect(redactMessage('lock 획득 실패')).toBe('lock 획득 실패');
  });
});

describe('KeychainAccountMissingError', () => {
  it('service 필드는 raw 값 보존, name 은 클래스명, instanceof Error', () => {
    const err = new KeychainAccountMissingError('com.example.codex');
    expect(err.service).toBe('com.example.codex');
    expect(err.name).toBe('KeychainAccountMissingError');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(KeychainAccountMissingError);
  });

  it('짧은 BUILTIN service 명은 메시지에 그대로 노출 (redact 미적용)', () => {
    const err = new KeychainAccountMissingError('com.openai.codex');
    expect(err.message).toContain('com.openai.codex');
    expect(err.service).toBe('com.openai.codex');
  });

  it('50자+ base64-like plugin service 는 메시지에서 redact 되지만 service 필드는 raw 보존', () => {
    // CLI def plugin 시나리오: 사용자가 긴 base64-like service 명 등록.
    // UI 는 instanceof 분기 후 err.service 를 별도 라인으로 surface 하면 정확한 식별 가능.
    const longService = 'a'.repeat(60);
    const err = new KeychainAccountMissingError(longService);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(longService);
    expect(err.service).toBe(longService);
  });

  it('초장문 service 명에도 message 는 500자 이내로 truncate (회귀 가드)', () => {
    // base64 미해당 문자 (한글) 로만 1000자 → redact 미적용, truncate 만 발동.
    // 메시지가 무한정 길어지지 않는다는 boundary contract.
    const hugeService = '한'.repeat(1000);
    const err = new KeychainAccountMissingError(hugeService);
    expect(err.message.length).toBeLessThanOrEqual(500);
    expect(err.service).toBe(hugeService);
  });
});

describe('describeError', () => {
  it('일반 Error 는 errorMessage 와 동일 (단일 라인)', () => {
    const err = new Error('lock 획득 실패');
    expect(describeError(err)).toBe(errorMessage(err));
    expect(describeError(err)).not.toContain('\n');
  });

  it('UsageError 도 errorMessage 와 동일', () => {
    const err = new UsageError('잘못된 인자');
    expect(describeError(err)).toBe(errorMessage(err));
  });

  it('Error 가 아닌 값도 errorMessage 와 동일', () => {
    expect(describeError('plain')).toBe(errorMessage('plain'));
    expect(describeError(42)).toBe(errorMessage(42));
    expect(describeError(null)).toBe(errorMessage(null));
  });

  it('KeychainAccountMissingError 는 message + "→ Service: ${service}" 라인 추가', () => {
    const err = new KeychainAccountMissingError('com.openai.codex');
    const out = describeError(err);
    expect(out).toContain('→ Service: com.openai.codex');
    expect(out.split('\n').length).toBeGreaterThanOrEqual(2);
    // 1번째 라인은 errorMessage 와 동일.
    expect(out.split('\n')[0]).toBe(errorMessage(err));
  });

  it('긴 plugin service 명: message 는 redact 되지만 → Service 라인은 raw 보존 (핵심 가치)', () => {
    // redactMessage 가 [redacted] 로 가린 service 를 사용자가 식별할 수 있게 surface.
    // 이 라인이 없으면 사용자는 어떤 Keychain service 를 정리해야 할지 알 수 없음.
    const longService = 'a'.repeat(60);
    const err = new KeychainAccountMissingError(longService);
    const out = describeError(err);
    expect(out).toContain('[redacted]');
    expect(out).toContain(`→ Service: ${longService}`);
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
