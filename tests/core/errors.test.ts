import { describe, expect, it } from 'vitest';

import {
  KeychainAccountMissingError,
  OsKeyringAccountMissingError,
  UsageError,
  ValidationError,
  describeError,
  errorMessage,
  redactMessage
} from '../../src/core/errors.js';

describe('UsageError', () => {
  it('exitCode 는 2, name 은 UsageError', () => {
    const err = new UsageError('잘못된 인자');
    expect(err.exitCode).toBe(2);
    expect(err.name).toBe('UsageError');
    expect(err.message).toBe('잘못된 인자');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('ValidationError', () => {
  it('UsageError 상속 → exitCode 2 자동, field 보존', () => {
    const err = new ValidationError('cliId 가 잘못됨', 'cliId');
    expect(err.exitCode).toBe(2);
    expect(err.field).toBe('cliId');
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('cliId 가 잘못됨');
    expect(err).toBeInstanceOf(UsageError);
    expect(err).toBeInstanceOf(Error);
  });

  it('cli.tsx top-level catch 가 instanceof UsageError 로 잡으면 ValidationError 도 자동 exit 2', () => {
    // 신규 호출자가 instanceof ValidationError 분기 안 해도 기존 UsageError 처리 경로로 흘러간다.
    const err: unknown = new ValidationError('msg', 'profileName');
    const exitCode = err instanceof UsageError ? err.exitCode : 1;
    expect(exitCode).toBe(2);
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

  it('provider prefix 토큰과 credential field 값을 redact', () => {
    const openAi = 'sk-' + 'fakeOpenAiToken1234';
    const google = 'ya29.' + 'fakeGoogleToken1234';
    const out = redactMessage(`OPENAI_API_KEY=${openAi} refresh_token="short-refresh" google=${google}`);
    expect(out).not.toContain(openAi);
    expect(out).not.toContain(google);
    expect(out).not.toContain('short-refresh');
    expect(out).toContain('OPENAI_API_KEY=[redacted]');
    expect(out).toContain('refresh_token="[redacted]"');
  });

  it('JSON/quoted credential field 값을 redact', () => {
    const out = redactMessage('{"access_token":"short-secret","password":"abc def"}');
    expect(out).toBe('{"access_token":"[redacted]","password":"[redacted]"}');
    expect(out).not.toContain('short-secret');
    expect(out).not.toContain('abc def');
  });

  it('escaped quote 를 포함한 quoted credential 값을 통째로 redact', () => {
    const out = redactMessage('{"password":"abc \\"def\\" ghi","authorization":"Bearer abc \\"def\\" ghi"}');
    expect(out).toBe('{"password":"[redacted]","authorization":"Bearer [redacted]"}');
    expect(out).not.toContain('def');
    expect(out).not.toContain('ghi');
  });

  it.each([
    ['Authorization: Bearer bearer-secret-12345', 'Authorization: Bearer [redacted]'],
    ['Authorization: Bearer "quoted-secret"', 'Authorization: Bearer "[redacted]"'],
    ['authorization="Bearer quoted-secret"', 'authorization="Bearer [redacted]"'],
    ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [redacted]'],
    ['authorization="Basic dXNlcjpwYXNz"', 'authorization="Basic [redacted]"'],
    ['Authorization:\nBearer newline-secret', 'Authorization:?Bearer [redacted]'],
    ['Authorization:\x1fBearer unit-secret', 'Authorization:?Bearer [redacted]'],
    ['Authorization:\x00Bearer nul-secret', 'Authorization:?Bearer [redacted]'],
    ['Authorization: Bearer sk-abcd\nefghijklmnop', 'Authorization: Bearer [redacted]'],
    [String.raw`Authorization: Bearer sk-abcd\nefghijklmnop`, 'Authorization: Bearer [redacted]']
  ])('Authorization Bearer 값을 redact: %s', (raw, expected) => {
    expect(redactMessage(raw)).toBe(expected);
  });

  it('secret field 값이 control 문자로 split 되어도 tail 을 남기지 않는다', () => {
    const out = redactMessage('token=eyJabc\n1234567890abcdef0123456789');
    expect(out).toBe('token=[redacted]');
    expect(out).not.toContain('1234567890');
  });

  it('standalone provider/JWT 토큰이 control 문자로 split 되어도 tail 을 남기지 않는다', () => {
    const provider = redactMessage('failed token sk-proj-\nabcdefghijklmnop');
    const providerAfterPrefix = redactMessage('failed token sk-\nabcdefghijklmnop');
    const providerEarly = redactMessage('failed token sk-p\nrojabcdefghijklmnop');
    const googleAfterPrefix = redactMessage('failed token ya29.\nabcdefghijklmnop');
    const slackAfterPrefix = redactMessage('failed token xoxb-\nabcdefghijklmnop');
    const escapedProvider = redactMessage(String.raw`failed token sk-proj-\nabcdefghijklmnop`);
    const escapedProviderAfterPrefix = redactMessage(String.raw`failed token sk-\nabcdefghijklmnop`);
    const jwt = redactMessage('failed token eyJhbGciOi\nJIUzI1NiIsInR5cCI6IkpXVCJ9.payloadsig');
    const jwtAfterPrefix = redactMessage('failed token eyJ\nabcdefghijklmnop1234567890');
    const jwtEarly = redactMessage('failed token eyJab\n1234567890abcdef');
    const escapedJwt = redactMessage(String.raw`failed token eyJ\nabcdefghijklmnop1234567890`);
    const escapedUnicodeJwt = redactMessage(String.raw`failed token eyJ\u000aabcdefghijklmnop1234567890`);
    expect(provider).toBe('failed token [redacted]');
    expect(providerAfterPrefix).toBe('failed token [redacted]');
    expect(providerEarly).toBe('failed token [redacted]');
    expect(googleAfterPrefix).toBe('failed token [redacted]');
    expect(slackAfterPrefix).toBe('failed token [redacted]');
    expect(escapedProvider).toBe('failed token [redacted]');
    expect(escapedProviderAfterPrefix).toBe('failed token [redacted]');
    expect(jwt).toBe('failed token [redacted-jwt]');
    expect(jwtAfterPrefix).toBe('failed token [redacted-jwt]');
    expect(jwtEarly).toBe('failed token [redacted-jwt]');
    expect(escapedJwt).toBe('failed token [redacted-jwt]');
    expect(escapedUnicodeJwt).toBe('failed token [redacted-jwt]');
  });

  it('제어 문자는 사용자 표시 전 치환한다', () => {
    expect(redactMessage('first\nsecond\tthird')).toBe('first?second?third');
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
    // UI 는 err.service raw 필드를 직접 표시하지 않고 describeError 의 안전 표시를 사용해야 한다.
    const longService = 'a'.repeat(60);
    const err = new KeychainAccountMissingError(longService);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(longService);
    expect(err.service).toBe(longService);
  });

  it('짧은 opaque plugin service 도 메시지에서 redact 되지만 service 필드는 raw 보존', () => {
    const opaqueService = 'a'.repeat(32);
    const err = new KeychainAccountMissingError(opaqueService);
    expect(err.message).toContain('[redacted]');
    expect(err.message).not.toContain(opaqueService);
    expect(err.service).toBe(opaqueService);
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

  it('KeychainAccountMissingError 는 message + 안전한 service 표시 라인 추가', () => {
    const err = new KeychainAccountMissingError('com.openai.codex');
    const out = describeError(err);
    expect(out).toContain('→ Service: com.openai.codex');
    expect(out.split('\n').length).toBeGreaterThanOrEqual(2);
    // 1번째 라인은 errorMessage 와 동일.
    expect(out.split('\n')[0]).toBe(errorMessage(err));
  });

  it('긴 plugin service 명: message 와 → Service 라인 모두 redact', () => {
    // plugin service 는 user-supplied 값이라 별도 라인도 secret-like 값을 그대로 노출하지 않는다.
    const longService = 'a'.repeat(60);
    const err = new KeychainAccountMissingError(longService);
    const out = describeError(err);
    expect(out).toContain('[redacted]');
    expect(out).toContain('→ Service: [redacted]');
    expect(out).not.toContain(longService);
  });

  it('짧은 opaque plugin service 명도 message 와 → Service 라인 모두 redact', () => {
    const opaqueService = 'a'.repeat(32);
    const err = new KeychainAccountMissingError(opaqueService);
    const out = describeError(err);
    expect(out).toContain('[redacted]');
    expect(out).toContain('→ Service: [redacted]');
    expect(out).not.toContain(opaqueService);
  });

  it('service 표시 라인의 제어 문자를 제거해 로그/터미널 injection 을 막는다', () => {
    const err = new KeychainAccountMissingError('svc\nINJECT\tNEXT');
    const out = describeError(err);
    expect(out).toContain('→ Service: svc?INJECT?NEXT');
    expect(out.split('\n')).toHaveLength(2);
  });

  it('OsKeyringAccountMissingError 도 service 라인을 sanitize/redact', () => {
    const err = new OsKeyringAccountMissingError('svc\u202Egnp.exe', 2);
    const out = describeError(err);
    expect(out).toContain('→ Service: svc?gnp.exe');
    expect(out).not.toContain('\u202E');
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
