/**
 * 라이브 자격증명 vs 프로필 저장본의 비교 (freshness inspect).
 *
 * OAuth refresh token rotation 사용 CLI (Codex/Gemini/OpenCode 등) 는 mat 의 swap
 * 모델과 본질적으로 충돌한다. CLI 가 자체 사용 중 refresh rotation 으로 라이브를
 * 갱신해도 mat 의 active 프로필 저장본은 stale 한 상태로 남는다. 다음 swap 시
 * stale 한 옛 refresh token 이 라이브로 복원되면 provider 가 "이미 사용된 token"
 * 으로 인지해 revoke — 사용자 인증이 깨진다.
 *
 * 본 모듈은 swap 전후로 mat 이 라이브와 저장본 차이를 보고하기 위한 helper.
 * 실제 mutation 결정 (재캡처/폐기/취소) 은 TUI (PR-G) 가 사용자에게 묻는다.
 *
 * 분류 체계:
 *  - `fresh`: byte-identical.
 *  - `rotated`: token 갱신 (subtype 으로 세분화) — adapter 가 identity 동일 확인.
 *      `value-only` = 자격증명 값만 변경, `meta-only` = 캐시 필드만 변경, `both`.
 *  - `stale`: 라이브/저장본 한쪽만 존재하거나 adapter 가 identity 변경 (다른 계정).
 *  - `inflight`: multi-source CLI 의 부분 갱신 상태 (일부 source 만 새 토큰).
 *
 * adapter 미정의 CLI 는 byte-diff fallback (refresh_token/access_token/id_token/
 * account_id 등 회전 후보 필드만 normalize 후 비교). fallback 의 결과는
 * confidence='low' — UI 가 사용자에게 "정확 분류 불가" 안내해야 한다.
 */

import { findCliDef } from './cli-defs.js';
import { envSecretSourceMetadata, isEnvSecretSource } from './env-secret-source.js';
import { UnknownCliError } from './errors.js';
import { redactSecretLikeMessage } from './freshness-adapters/_shared.js';
import { readProfileFile } from './profile-store.js';
import { readSource } from './sources.js';
import {
  isWindowsCredentialSource,
  isWindowsCredentialRuntimeUnsupported,
  windowsCredentialSourceMetadata
} from './windows-credential-source.js';

/** 라이브 vs 저장본 비교 결과의 4-state 분류. */
export type CompareKind = 'fresh' | 'rotated' | 'stale' | 'inflight' | 'unsupported';

/** `rotated` 결과의 세분화 — kind='rotated' 일 때만 의미. */
export type RotatedSubtype = 'value-only' | 'meta-only' | 'both';

/** 비교 결과의 신뢰도. 'low' 는 fallback (정확 분류 불가) 표시. */
export type Confidence = 'high' | 'medium' | 'low';

/**
 * 단일 source 비교 결과.
 *
 * `subtype` 은 `kind === 'rotated'` 일 때만 설정. 그 외 kind 에서 subtype 이 있어도
 * 런타임에 무시한다 (런타임 enforcement 보다 TypeScript narrowing 으로 caller 가 분기).
 */
export interface CompareResult {
  kind: CompareKind;
  subtype?: RotatedSubtype;
  confidence: Confidence;
  /** UI 에 surface 할 사람-친화 설명. 로그/표 출력에 사용. */
  detail?: string;
}

/** (saveAs, 비교 결과) 쌍. CLI 의 source 별 1건. */
export interface SourceFreshness {
  saveAs: string;
  result: CompareResult;
}

/** 한 (cliId, profileName) 쌍의 전체 freshness 보고. */
export interface FreshnessReport {
  cliId: string;
  profileName: string;
  sources: SourceFreshness[];
}

/**
 * CLI 별 source 비교 adapter.
 *
 * 등록된 CLI 는 `inspectLiveFreshness` 가 adapter.compare 를 호출. 미등록 CLI 는
 * `fallbackCompare` (화이트리스트 byte-diff). adapter 가 던지는 예외는 잡혀서
 * fallback 으로 떨어진다 (silent 회피 — detail 에 원인 surface).
 *
 * registry key 는 cliId. multi-source CLI 의 source 별 분기는 adapter 가
 * saveAs 인자로 내부 분기한다.
 *
 * **CompareResult.detail 의 secret leak 방어 contract (PR-G quad-review #14)**:
 *  - detail 은 TUI dialog (FreshnessDialog) 와 `mat freshness` CLI 표 양쪽에
 *    그대로 렌더링된다. 따라서 OAuth token / access_token / refresh_token /
 *    email / accountId 등 raw 값은 절대 detail 에 포함하지 말 것.
 *  - identity 식별이 필요하면 `maskIdentifier` (errors-mask.ts) 의 SHA-256
 *    fingerprint 형태로 마스킹. 예: `identity match: ${mask(email)}`.
 *  - plugin 작성자도 본 contract 를 지켜야 — adapter 등록 시 detail 의
 *    raw 자격증명 직접 노출 금지.
 *  - 본 contract 위반 시 사용자 터미널 scrollback / screen recording 으로
 *    자격증명 누설 가능 — `screens.tsx` 의 dialog 렌더가 256자 truncate 하지만
 *    근본 방어는 adapter 책임.
 */
export interface SourceAdapter {
  compare(saveAs: string, stored: string, live: string): CompareResult;
}

const adapters = new Map<string, SourceAdapter>();

/**
 * builtin adapter 가 lazy 자동 등록되었는지 추적.
 *
 * `inspectLiveFreshness` 첫 호출 시 dynamic import 로 `registerAllBuiltinAdapters`
 * 를 한 번만 실행 (circular dep 회피). `resetAdapters` 호출 후엔 false 로 리셋해
 * test 가 fallback 동작을 직접 검증 가능 (quad-review HIGH fix — silent fallback
 * 차단).
 */
let builtinAdaptersInitialized = false;

/** adapter 등록. cli-defs 의 builtin 으로 매핑. 테스트도 동일 API 사용. */
export function registerAdapter(cliId: string, adapter: SourceAdapter): void {
  adapters.set(cliId, adapter);
}

/** 테스트가 사용 — registry 초기화. production 호출 금지. */
export function resetAdapters(): void {
  adapters.clear();
  builtinAdaptersInitialized = false;
}

/**
 * builtin adapter 가 미등록 상태면 dynamic import 후 1회 등록.
 *
 * cli.tsx 외 진입점 (TUI swap, programmatic API) 에서도 silent fallback (identity
 * 검증 우회) 을 차단. dynamic import 라 circular dep 안전. test 가
 * `resetAdapters()` 직후 명시적으로 fallback 검증할 수 있도록 lazy.
 */
async function ensureBuiltinAdapters(): Promise<void> {
  if (builtinAdaptersInitialized) return;
  builtinAdaptersInitialized = true;
  const mod = await import('./freshness-adapters/index.js');
  mod.registerAllBuiltinAdapters();
}

/** 외부 조회 헬퍼 — 미등록 시 undefined. */
export function getAdapter(cliId: string): SourceAdapter | undefined {
  return adapters.get(cliId);
}

/**
 * 사용자 액션 (재캡처/폐기/취소 dialog) 이 필요한 보고인지 판정.
 *
 * 분류 기준 (plan §188):
 *  - `fresh` (모든 source) → 사용자 액션 불필요 (false).
 *  - `rotated` 또는 `stale` 하나라도 → dialog 표시 필요 (true).
 *  - `inflight` 하나라도 → dialog 표시 필요 (true, 재시도 안내 톤).
 *
 * `mat freshness` CLI 의 exit 1 (`hasUnsafe` in cli.tsx) 와는 별도 — 본 predicate
 * 는 TUI dialog 의 표시 여부 결정에만 사용. CLI 의 unsafe 판정은 chain 차단을
 * 위해 더 엄격하다 (low-confidence rotated 도 unsafe).
 *
 * 빈 sources 케이스 (`report.sources.length === 0`) 는 false 반환 — 정상 동작.
 * BUILTIN_CLI_DEFS / plugin loader 가 sources >= 1 invariant 를 보장하므로
 * 실제로는 dead branch. CLI def 의 sources 가 비어 있는 anomaly 는 cli-defs
 * 단계에서 차단되어야지 본 predicate 에 도달하지 말아야 한다.
 *
 * 불변식: `hasInflight(report) ⇒ needsUserAttention(report)` — `inflight` 는
 * `fresh` 가 아니므로 inflight 검사가 attention 검사를 함의한다. caller 가 분기
 * 순서를 바꿀 때 본 함의를 깨지 않도록 freshness.test.ts 에서 invariant 검증.
 */
export function needsUserAttention(report: FreshnessReport): boolean {
  return report.sources.some((s) => s.result.kind !== 'fresh');
}

/**
 * `inflight` 보고 — multi-source CLI 의 부분 갱신 race. 재시도 안내가 적절.
 * TUI 가 일반 3-옵션 dialog 대신 "잠시 후 재시도" 안내로 분기할 수 있도록 별도 헬퍼.
 */
export function hasInflight(report: FreshnessReport): boolean {
  return report.sources.some((s) => s.result.kind === 'inflight');
}

/**
 * byte-diff fallback 의 normalize 화이트리스트.
 *
 * OAuth/API key 류 회전 후보 필드만 비교. `last_refresh` / `expiry_date` /
 * `expires` 같은 캐시 필드는 의도적으로 제외 — 정상 사용 중 자주 갱신되는
 * 메타라 비교 noise 만 만든다.
 *
 * provider 별 변형:
 *  - Codex/Gemini 류: snake_case (`refresh_token`)
 *  - OpenCode: 단축형 (`refresh`, `access`, `accountId`)
 *  - 미래 CLI: 새 필드는 adapter 에서 명시 처리, fallback 은 보수적으로 유지.
 */
const ROTATION_FIELDS = new Set([
  'refresh_token',
  'access_token',
  'id_token',
  'account_id',
  'refresh',
  'access',
  'id',
  'accountId',
  'sub'
]);

/**
 * 정규화 단계에서 무조건 제외하는 위험 키 — prototype pollution 방어.
 * `JSON.parse` 가 반환한 객체에 `__proto__` / `constructor` / `prototype` 키가
 * 있어도 normalize 결과 객체에 복사하지 않는다. 회귀 가드는 freshness.test.ts.
 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * raw JSON 을 회전 후보 필드만 남긴 정규화 문자열로 변환. JSON 아니면 null.
 * 중첩 객체도 재귀 walk — OpenCode 의 `{ openai: { refresh, access, accountId } }` 처리.
 */
function normalizeJsonForCompare(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const filtered = filterRotationFields(parsed);
  try {
    return JSON.stringify(filtered);
  } catch {
    return null;
  }
}

/**
 * ROTATION_FIELDS 만 남기고 나머지 키 제거. 배열/원시값은 그대로.
 *
 * 보안: 결과 객체는 `Object.create(null)` — `__proto__`/`constructor`/`prototype`
 * 같은 위험 키는 DANGEROUS_KEYS 체크로 무조건 drop. credential JSON 이
 * `{"__proto__":{"refresh_token":"x"}}` 형태로 와도 normalize 결과를 조작 못함.
 */
function filterRotationFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(filterRotationFields);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(key)) {
      continue;
    }
    if (ROTATION_FIELDS.has(key)) {
      out[key] = filterRotationFields(val);
    } else if (val !== null && typeof val === 'object') {
      const nested = filterRotationFields(val) as Record<string, unknown>;
      if (Object.keys(nested).length > 0) {
        out[key] = nested;
      }
    }
  }
  return out;
}

/**
 * adapter 미정의 CLI 를 위한 fallback 비교.
 *
 * 1) byte-identical → fresh (high confidence)
 * 2) 화이트리스트 필드만 변경 → rotated value-only (medium confidence — identity 미검증)
 * 3) 화이트리스트 외 캐시 필드만 변경 → rotated meta-only (medium)
 * 4) JSON 아니거나 parse 실패 → rotated both (low — byte 만 비교)
 *
 * `stale` 분류는 fallback 으로 불가능 — identity 비교가 없기 때문이다. adapter
 * 미등록 CLI 에서 identity 변경 시나리오는 후속 PR (PR-H) 의 adapter 추가로 해결.
 */
export function fallbackCompare(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const normalizedStored = normalizeJsonForCompare(stored);
  const normalizedLive = normalizeJsonForCompare(live);
  if (normalizedStored !== null && normalizedLive !== null) {
    // 빈 객체 (`{}`) — 화이트리스트 회전 필드가 양쪽 모두 부재 →  fresh 판정 불가
    // (plugin CLI 가 `{apiKey: ...}` 같이 화이트리스트 외 필드만 쓰면 양쪽
    // normalize 결과가 모두 `{}` → equal 이라고 fresh 처리 시 실제 자격증명
    // 변경을 안전 통과시키는 사고. quad-review HIGH fix.)
    if (normalizedStored === '{}' && normalizedLive === '{}') {
      return {
        kind: 'rotated',
        subtype: 'both',
        confidence: 'low',
        detail: 'fallback: 화이트리스트 회전 필드 부재 — adapter 추가 권장'
      };
    }
    if (normalizedStored === normalizedLive) {
      // 회전 후보 필드 (refresh_token 등) 가 동일하므로 사용자 자격증명 자체는
      // 변경 없음 — 캐시/timestamp 만 갱신된 정상 사용 noise. dialog 띄울 가치
      // 없으므로 fresh 로 분류.
      return {
        kind: 'fresh',
        confidence: 'medium',
        detail: '회전 후보 필드 동일 — 캐시 필드만 변경 (정상 사용)'
      };
    }
    return {
      kind: 'rotated',
      subtype: 'value-only',
      confidence: 'low',
      detail: 'fallback byte-diff: identity 확정 불가 — adapter 미등록 CLI'
    };
  }
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'low',
    detail: 'non-JSON content — byte 비교만'
  };
}

/**
 * (cliId, profileName) 의 모든 source 에 대해 라이브 vs 저장본 비교 보고.
 *
 * 누락 케이스:
 *  - 양쪽 부재 → fresh (변경 없음). swap 무의미한 source 도 동일하게 표현.
 *  - 라이브만 부재 → stale (라이브가 빈 상태 — CLI 로그아웃 등).
 *  - 저장본만 부재 → stale (캡처 안 됨 — 신규 source 추가 시).
 *
 * adapter 가 던진 예외는 잡혀서 fallback 으로 떨어진다 — detail 에 원인 surface.
 * 회복 가능 에러로 가정 (parse 실패 등). 시스템 에러 (fs 권한) 는 호출자가 처리.
 */
export async function inspectLiveFreshness(
  cliId: string,
  profileName: string
): Promise<FreshnessReport> {
  // builtin adapter 자동 등록 — 진입점 무관 silent fallback 차단 (quad-review HIGH fix).
  await ensureBuiltinAdapters();
  const def = findCliDef(cliId);
  if (!def) {
    throw new UnknownCliError(cliId);
  }
  const adapter = adapters.get(cliId);
  const sources: SourceFreshness[] = [];
  for (const src of def.sources) {
    if (isEnvSecretSource(src)) {
      const meta = envSecretSourceMetadata(src);
      sources.push({
        saveAs: src.saveAs,
        result: {
          kind: 'unsupported',
          confidence: 'high',
          detail: `${meta.reason}: ${meta.envName}/${meta.backendKind}`
        }
      });
      continue;
    }
    if (isWindowsCredentialSource(src) && isWindowsCredentialRuntimeUnsupported(src)) {
      const meta = windowsCredentialSourceMetadata(src);
      sources.push({
        saveAs: src.saveAs,
        result: {
          kind: 'unsupported',
          confidence: 'high',
          detail: `${meta.reason}: win32/${meta.credentialType}`
        }
      });
      continue;
    }
    const stored = await readProfileFile(cliId, profileName, src.saveAs);
    const live = await readSource(src);
    sources.push({ saveAs: src.saveAs, result: compareOne(adapter, src.saveAs, stored, live) });
  }
  return { cliId, profileName, sources: aggregateInflight(sources) };
}

/**
 * multi-source CLI 의 cross-source 부분 갱신 race 를 `inflight` 로 reclassify (PR-S).
 *
 * 모순 시나리오:
 *  - 한 source 는 `rotated` (token 변경, identity 동일) 인데
 *  - 다른 source 는 `stale` (identity 변경 — 다른 계정 추정)
 *
 * 같은 swap 시점에 한 CLI 의 source 가 동시에 "같은 계정" + "다른 계정" 으로 보일
 * 수는 없다 — CLI 가 자체적으로 두 source 를 갱신하는 중간 race 상태 추정. 사용자
 * 가 swap 진행 시 어느 source 의 결과를 신뢰할지 모호 → `inflight` 로 reclassify
 * 해 TUI dialog 가 "재시도 권장" 안내. exit code 1 (unsafe) 도 자동 트리거.
 *
 * 적용 대상: `rotated` 또는 `stale` 로 분류된 source 만. `fresh` source 는 race
 * 와 무관하므로 그대로 보존. single-source CLI 는 no-op (length < 2).
 *
 * `inflight` confidence: medium — 일시적 race 일 가능성이 가장 높지만 (retry 로
 * 해결 가능) 실제 multi-account 운영 중 swap race 가능성도 배제 못 함.
 *
 * 한계 (PR-S Codex iter 1 valid HIGH critique):
 *  - 옛 분류 (rotated value-only + stale identity 변경) 가 race 아닌 의도된 사용자
 *    액션 (token rotation 직후 다른 계정 로그인) 일 수 있음 — 이 경우 사용자는
 *    재캡처/swap 진행이 합리적. 본 PR 은 보수적으로 inflight 분류 + TUI dialog (PR-G
 *    의 recapture/discard/cancel) 로 사용자가 결정 가능.
 *  - `rotated + rotated` (각 source 토큰만 부분 갱신) 또는 `rotated + fresh` 는
 *    현재 race 감지 대상 외 — 추후 sample-based detection (짧은 retry 후 동일 →
 *    실제 stale fallback) 으로 확장 가능.
 *  - 향후 더 정교한 race detection (time window / N회 retry / source-level
 *    aggregate fixture v2) 는 별도 follow-up PR.
 */
function aggregateInflight(sources: SourceFreshness[]): SourceFreshness[] {
  if (sources.length < 2) return sources;
  const hasRotated = sources.some((s) => s.result.kind === 'rotated');
  const hasStale = sources.some((s) => s.result.kind === 'stale');
  if (!hasRotated || !hasStale) return sources;
  return sources.map((s) => {
    if (s.result.kind === 'rotated' || s.result.kind === 'stale') {
      return {
        saveAs: s.saveAs,
        result: {
          kind: 'inflight' as const,
          confidence: 'medium' as const,
          detail: `cross-source race (옛 분류: ${s.result.kind}) — 재시도 권장`
        }
      };
    }
    return s;
  });
}

/**
 * 단일 source 의 비교. 누락/adapter/fallback 분기.
 * adapter 가 던진 예외는 fallback 으로 떨어진다 (silent 회피 — detail surface).
 */
function compareOne(
  adapter: SourceAdapter | undefined,
  saveAs: string,
  stored: string | null,
  live: string | null
): CompareResult {
  if (stored == null && live == null) {
    return { kind: 'fresh', confidence: 'high', detail: '양쪽 부재 — swap 무관' };
  }
  if (stored == null) {
    return {
      kind: 'stale',
      confidence: 'high',
      detail: '프로필 저장본 부재 — 라이브 캡처 권장'
    };
  }
  if (live == null) {
    return {
      kind: 'stale',
      confidence: 'high',
      detail: '라이브 부재 — CLI 로그아웃 추정'
    };
  }
  if (!adapter) {
    return fallbackCompare(stored, live);
  }
  try {
    return adapter.compare(saveAs, stored, live);
  } catch (err) {
    // adapter 예외 → 실제 fallbackCompare 호출 후 detail 에 예외 메시지 append.
    // (quad-review MEDIUM fix: catch 가 generic rotated 만 반환하면 byte-diff
    // 비교 자체를 건너뛰어 의미 손실. fallback 정상 분류 + 예외 surface 가 정합.)
    //
    // PR-L (PR-H quad-review iter 2 M4 fix 마무리): adapter 예외 메시지에 raw
    // payload 일부 (access_token/refresh_token 등) 가 포함될 가능성 — 사용자 detail
    // 에 그대로 surface 하면 CI 로그/dialog 화면에 secret 누설. SourceAdapter
    // contract (line 76-87) 는 정상 return 의 detail 만 redact 의무화 했으므로
    // throw path 는 별도 방어가 필요. _shared.redactSecretLikeMessage 로 base64-like
    // 20자+ 및 JWT prefix 를 <redacted> 처리 + 120자 cap.
    const result = fallbackCompare(stored, live);
    const adapterMsg = redactSecretLikeMessage((err as Error).message);
    return {
      ...result,
      detail: `${result.detail ? `${result.detail}; ` : ''}adapter 예외: ${adapterMsg}`
    };
  }
}
