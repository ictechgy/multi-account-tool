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
 * Keychain 항목의 기존 account 메타데이터를 파악할 수 없어 안전 swap 을 거부한 경우.
 * service-only 삭제는 동일 service 의 타 항목까지 영향을 줄 수 있어 data loss 위험.
 *
 * 호출자 (TUI / switcher / exec) 는 instanceof 로 분기하여 사용자에게
 * Keychain Access.app 정리 안내를 명확히 표시할 수 있다.
 *
 * message 는 sources.ts 의 다른 keychain throw 와 동일하게 redactMessage 통과 —
 * 현재는 service 명이 운영 컨텍스트지만 ROADMAP 의 CLI def plugin 도입 시
 * user-supplied service 가 들어올 수 있어 정의 시점에 방어선 적용.
 * Typed caller 는 readonly service 필드로 raw 값에 직접 접근 가능.
 *
 * **UI 권장**: redactMessage 가 50자+ base64-like service 명을 [redacted] 로
 * 가릴 수 있으므로, instanceof 분기 후 `err.service` 를 별도 라인 (또는 안내
 * UI 의 보조 필드) 으로 surface 해야 사용자가 어떤 service 를 정리해야 할지
 * 식별 가능. 현재 BUILTIN service 명은 짧아 redact 가 발생하지 않음.
 */
export class KeychainAccountMissingError extends Error {
  readonly service: string;
  constructor(service: string) {
    super(redactMessage(
      `keychain service '${service}' 의 기존 항목 account 를 파악할 수 없어 안전 swap 을 거부합니다. ` +
      `service-only 삭제는 동일 service 의 타 항목까지 영향을 줄 수 있어 data loss 위험이 있습니다. ` +
      `Keychain Access.app 에서 해당 service 의 항목을 수동 정리 후 다시 시도하세요.`
    ));
    this.name = 'KeychainAccountMissingError';
    this.service = service;
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

/**
 * 사용자 표시용 에러 설명. errorMessage 결과에 타입별 컨텍스트 라인을 덧붙인다.
 *
 * 현재 분기:
 *  - KeychainAccountMissingError: redactMessage 가 긴 base64-like service 명을
 *    [redacted] 로 가릴 수 있으므로, raw `service` 를 별도 라인으로 surface 한다.
 *    사용자가 Keychain Access.app 에서 어떤 service 를 정리할지 식별 가능.
 *  - 그 외: errorMessage 와 동일 (단일 라인).
 *
 * 호출자는 multi-line 표시가 허용되는 곳에서만 사용 (TUI message body, mat exec stderr).
 * 단일 라인 컨텍스트 (예: first import 의 per-cli failure summary) 에는 errorMessage 유지.
 */
export function describeError(err: unknown): string {
  const msg = errorMessage(err);
  if (err instanceof KeychainAccountMissingError) {
    return `${msg}\n→ Service: ${err.service}`;
  }
  return msg;
}
