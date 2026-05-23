/**
 * 공용 에러 처리 유틸.
 * UI 핸들러 14곳에서 동일하게 쓰이던 errorMessage 추출.
 */

/**
 * 에러 객체에서 사용자에게 보여줄 메시지를 안전하게 추출.
 * - Error 인스턴스 → `.message`
 * - 그 외 → String 변환
 */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
