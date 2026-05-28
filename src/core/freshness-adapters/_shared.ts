/**
 * freshness adapter 들이 공유하는 helper.
 *
 * 모든 adapter (codex/gemini/opencode/claude/goose) 가 동일한 parse/sanitize 패턴을
 * 사용해 DRY 보장 + 보안 contract (prototype pollution / detail secret leak) 단일화.
 *
 * 도입 (PR-H iter 1 fix):
 *  - `parseJsonObject` — 5 adapter 의 중복 정의 제거 (Claude-1 LOW + Claude-2 L1)
 *  - `DANGEROUS_KEYS` — freshness.ts 와 동일 prototype pollution 가드 (M3)
 *  - `redactSecretLikeMessage` — adapter throw path 의 detail secret leak 방어 (M4)
 */

/**
 * JSON object literal 만 안전 parse. 배열 / 원시값 / null / parse 실패는 모두 null.
 *
 * 호출자가 `obj.foo` 같은 키 접근만 하도록 — array 가 통과되면 후속 코드가 length /
 * map / forEach 등을 호출해 잘못된 분기로 떨어질 수 있다.
 */
export function parseJsonObject<T>(raw: string): T | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as T;
  } catch {
    return null;
  }
}

/**
 * prototype pollution 위험 키 — adapter 가 무차별 key indexing 할 때 무조건 skip.
 *
 * freshness.ts 의 동명 상수와 일치. 두 곳을 동기화해야 — 한쪽만 갱신하면 안전망에
 * 구멍. 향후 위험 키 추가 시 양쪽 모두 갱신.
 *
 * (분리해 단일 source 로 만들지 않은 이유: freshness.ts 가 adapter 모듈을 import
 * 하면 circular dep. _shared 가 freshness 를 import 하는 방향도 lazy / dynamic
 * import 필요해 복잡도 증가. 두 상수 동기화는 lint 차원 follow-up 권장.)
 */
export const DANGEROUS_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * adapter 가 throw 한 예외의 message 를 detail 에 surface 하기 전 redact.
 *
 * SourceAdapter contract (freshness.ts:76-87) 의 secret leak 방어가 normal return
 * path 만 보호. throw path 는 `freshness.ts:364-376` 의 catch 가 `err.message` 를
 * detail 에 append — 향후 adapter 가 raw payload 일부를 message 에 포함할 가능성에
 * 대비 (M4 quad-review iter 1 합의).
 *
 * 정책:
 *  - 20자 이상 base64-like 시퀀스 → `<redacted>` (refresh_token / access_token 류)
 *  - JWT prefix (`eyJ`) → `<redacted-jwt>`
 *  - 120자 truncate (detail UI 폭 cap)
 */
export function redactSecretLikeMessage(s: string): string {
  return s
    .replace(/eyJ[A-Za-z0-9+/=._-]{20,}/g, '<redacted-jwt>')
    .replace(/[A-Za-z0-9+/=_-]{20,}/g, '<redacted>')
    .slice(0, 120);
}
