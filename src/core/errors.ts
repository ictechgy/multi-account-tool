/**
 * 공용 에러 처리 + 토큰 redact 유틸.
 *
 * `exitCode` 프로퍼티가 붙은 에러는 cli.tsx 의 top-level catch 에서 같은 코드로 종료된다
 * (UsageError = 2, LockHeldError = 75, restore 실패는 ExecResult 경로로 별도 처리).
 */

/** 인자/입력 검증 실패. cli.tsx 가 exit 2 로 매핑. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * 자격증명/토큰 후보 시퀀스를 redact.
 * JWT (eyJ...) 패턴과 50자 이상 base64-like 시퀀스를 [redacted] 로 대체하고 500자로 절단.
 *
 * sources.ts 의 keychain 에러뿐 아니라 모든 사용자 노출 에러에 적용된다.
 */
export function redactMessage(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9+/=._-]{20,}/g, '[redacted-jwt]')
    .replace(/[A-Za-z0-9+/=_-]{50,}/g, '[redacted]')
    .slice(0, 500);
}

/**
 * 에러 객체에서 사용자에게 보여줄 메시지를 안전하게 추출.
 * - Error 인스턴스 → `.message` (redact 적용)
 * - 그 외 → String 변환 (redact 적용)
 */
export function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactMessage(raw);
}
