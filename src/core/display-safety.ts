/**
 * 사용자/플러그인 제공 문자열을 터미널/로그에 표시하기 전 적용하는 공통 안전장치.
 *
 * C0/C1 control, Unicode format controls(bidi/zero-width), line/paragraph
 * separator 는 터미널 출력 spoofing 또는 로그 라인 위조에 쓰일 수 있어 표시 전 치환하고,
 * 플러그인 입력 검증에서는 거부한다.
 */

const DISPLAY_UNSAFE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const DISPLAY_UNSAFE_GLOBAL_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export function hasUnsafeDisplayChar(value: string): boolean {
  return DISPLAY_UNSAFE_RE.test(value);
}

export function sanitizeDisplayText(value: string): string {
  return value.replace(DISPLAY_UNSAFE_GLOBAL_RE, '?');
}
