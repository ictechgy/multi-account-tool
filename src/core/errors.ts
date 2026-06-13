/**
 * 공용 에러 처리 + 토큰 redact 유틸.
 *
 * `exitCode` 프로퍼티가 붙은 에러는 cli.tsx 의 top-level catch 에서 같은 코드로 종료된다
 * (UsageError = 2, LockHeldError = 75, restore 실패는 ExecResult 경로로 별도 처리).
 */

import { createHash } from 'node:crypto';
import { redactSecretLikeText } from './redaction.js';

/** maskIdentifier 의 fingerprint 길이 (hex 자리수). 정책 변경 시 단일 source. */
const MASK_FINGERPRINT_LENGTH = 12;

/**
 * 사용자 식별자 (email / accountId 등) 를 stable SHA-256 fingerprint 로 마스킹.
 *
 * adapter detail / `mat freshness` stdout / `--json` 출력에 raw identifier 가
 * 노출되면 CI logs / shell history / support bundle 로 누설된다 (quad-review MED
 * consensus). 마스킹 후엔 두 다른 identifier 를 구분 가능 (서로 다른 hash) 하면서도
 * raw 값은 노출되지 않는다.
 *
 * 빈 문자열은 `<empty>` (hash collision 회피).
 *
 * fingerprint 길이 (PR-U): 8 hex → **12 hex (48-bit)**.
 *  - 옛 8 hex (32-bit) 는 birthday bound ~65K identifier collision 가능성 → 단일
 *    사용자의 여러 계정 (예: 5~10 계정) 에선 안전했지만 fleet 단위 (수천 사용자
 *    aggregate) 에선 충돌 위험 명확.
 *  - 12 hex (48-bit) 는 birthday bound ~16M → fleet/audit scenario 에서도 충돌
 *    실용 무시 가능.
 *  - UI 표시 폭 trade-off: `<hash:00000000>` → `<hash:000000000000>` 4 chars 증가.
 *    detail 열 폭이 약 20 chars → 24 chars 로 늘지만 사용자 가독성 영향 미미.
 *
 * 단방향 — 비교 가능하지만 역추적 불가. 단 사전 공격에는 약함 (짧은 fingerprint).
 * 본 함수는 audit-grade 비밀 보호 용도가 아닌 UI 누설 방지 용도 (defense in depth).
 *
 * 정식 마스킹 규칙은 `tests/fixtures/oauth/MASKING_RULES.md` 참고.
 */
export function maskIdentifier(value: string): string {
  if (!value) return '<empty>';
  const hash = createHash('sha256').update(value).digest('hex').slice(0, MASK_FINGERPRINT_LENGTH);
  return `<hash:${hash}>`;
}

/** 인자/입력 검증 실패. cli.tsx 가 exit 2 로 매핑. */
export class UsageError extends Error {
  readonly exitCode = 2;
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/**
 * 알 수 없는 CLI id 호출. UsageError 의 서브클래스 — exit 2 자동 상속.
 *
 * 이전엔 `Error("알 수 없는 CLI: ...")` 로 throw 되어 호출자가 message 정규식
 * 매칭으로 exit code 분기를 결정했다 — 메시지 변경 시 silently exit 74 회귀
 * 위험 (quad-review MED fix). 본 클래스 도입 후 호출자는 `instanceof
 * UnknownCliError` 로 분기. readonly `cliId` 로 raw 값 직접 접근.
 */
export class UnknownCliError extends UsageError {
  readonly cliId: string;
  constructor(cliId: string) {
    super(`알 수 없는 CLI: ${cliId}`);
    this.name = 'UnknownCliError';
    this.cliId = cliId;
  }
}

/**
 * 입력값 검증 실패 (cliId / profileName / profileFileName 등).
 * UsageError 의 서브클래스 — exit 2 매핑은 그대로 상속.
 *
 * 기존 호출자는 instanceof UsageError 로 잡히므로 영향 없음.
 * 신규 호출자는 instanceof ValidationError 로 분기해 `field` 로 어떤 입력이
 * 잘못됐는지 식별 가능 (예: TUI 입력 폼의 inline 에러 표시).
 */
export class ValidationError extends UsageError {
  readonly field: string;
  constructor(message: string, field: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
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
 * **UI 권장**: `err.service` 는 raw 필드로 보존되지만 사용자 표시는 describeError 의
 * Service 라인처럼 sanitize/redact 를 거친 값을 사용한다. BUILTIN service 명은 짧고
 * printable 이라 그대로 보이며, user-supplied plugin service 는 secret/control-like
 * 값이면 표시 시 가려진다.
 */
export class KeychainAccountMissingError extends Error {
  readonly service: string;
  constructor(service: string) {
    const displayService = formatServiceForDisplay(service);
    super(redactMessage(
      `keychain service '${displayService}' 의 기존 항목 account 를 파악할 수 없어 안전 swap 을 거부합니다. ` +
      `service-only 삭제는 동일 service 의 타 항목까지 영향을 줄 수 있어 data loss 위험이 있습니다. ` +
      `Keychain Access.app 에서 해당 service 의 항목을 수동 정리 후 다시 시도하세요.`
    ));
    this.name = 'KeychainAccountMissingError';
    this.service = service;
  }
}

/**
 * os-keyring (Linux Secret Service) 에서 `secret-tool search --all` 결과가 N>1
 * (collision) 이라 안전 swap 을 거부한 경우.
 *
 * service+account 2-attribute 조회는 보통 0/1 매칭이지만, 동일 service 에 같은
 * account 가 비정상 중복되었거나 account 미지정 service-only 조회 시 N>1 이 될 수
 * 있다. `secret-tool clear` 는 매칭 항목을 **전부 삭제**(deletes-all) 하므로,
 * N>1 인 채로 clear/backup 을 진행하면 무관한 sibling 자격증명까지 파괴된다
 * (data loss). 따라서 N>1 이면 이 에러로 거부한다.
 *
 * macOS 의 {@link KeychainAccountMissingError} 와 의미상 구별된다 — 전자는
 * account 메타데이터 미식별, 본 에러는 다중 매칭(collision). backend 식별
 * 명확성을 위해 별도 클래스로 둔다.
 *
 * message 는 redactMessage 통과 (user-supplied service 대비). Typed caller 는
 * readonly `service` 로 raw 값 접근 — describeError 가 별도 라인으로 surface.
 */
export class OsKeyringAccountMissingError extends Error {
  readonly service: string;
  /**
   * @param matchCount search --all 매칭 수. 1 이면 "account 식별 불가"(stderr 의
   *   attribute.account 부재 + scope account 도 없음 → blind clear/rollback 위험),
   *   2 이상이면 collision (deletes-all 로 sibling 파괴 위험). 둘 다 안전 swap 거부.
   */
  constructor(service: string, matchCount: number) {
    const reason = matchCount > 1
      ? `${matchCount} 개의 항목이 매칭되어(collision)`
      : `기존 항목의 account 를 식별할 수 없어`;
    const displayService = formatServiceForDisplay(service);
    super(redactMessage(
      `os-keyring service '${displayService}' 에서 ${reason} 안전 swap 을 거부합니다. ` +
      `secret-tool clear 는 매칭 항목을 전부 삭제하므로, account 를 확정하지 못한 채 진행하면 ` +
      `무관한 자격증명까지 손실될 수 있습니다. ` +
      `secret-tool 또는 keyring 관리 도구에서 해당 service 의 항목을 정리 후 다시 시도하세요.`
    ));
    this.name = 'OsKeyringAccountMissingError';
    this.service = service;
  }
}

/**
 * 자격증명/토큰 후보 시퀀스를 redact.
 * field-aware token 값, 주요 provider prefix, JWT, 50자+ base64-like 를 가리고 500자로 절단.
 *
 * sources.ts 의 keychain 에러뿐 아니라 모든 사용자 노출 에러에 적용된다.
 */
export function redactMessage(s: string): string {
  return redactSecretLikeText(s, {
    secretMarker: '[redacted]',
    jwtMarker: '[redacted-jwt]',
    longSecretMin: 50,
    maxLength: 500
  });
}

export function formatServiceForDisplay(service: string): string {
  return redactSecretLikeText(service, {
    secretMarker: '[redacted]',
    jwtMarker: '[redacted-jwt]',
    longSecretMin: 16,
    maxLength: 500
  });
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
 *  - KeychainAccountMissingError / OsKeyringAccountMissingError: service 를 별도 라인에
 *    surface 하되, user-supplied plugin service 일 수 있으므로 control char 제거 +
 *    secret-like redact 를 적용한다.
 *  - 그 외: errorMessage 와 동일 (단일 라인).
 *
 * 호출자는 multi-line 표시가 허용되는 곳에서만 사용 (TUI message body, mat exec stderr).
 * 단일 라인 컨텍스트 (예: first import 의 per-cli failure summary) 에는 errorMessage 유지.
 */
export function describeError(err: unknown): string {
  const msg = errorMessage(err);
  if (err instanceof KeychainAccountMissingError || err instanceof OsKeyringAccountMissingError) {
    return `${msg}\n→ Service: ${formatServiceForDisplay(err.service)}`;
  }
  return msg;
}
