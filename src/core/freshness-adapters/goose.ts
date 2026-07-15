/**
 * Goose (Block 의 오픈소스 AI agent) 의 freshness adapter.
 *
 * Source (cli-defs.ts gooseSources):
 *  - macOS: keychain `{ service: 'goose', account: 'secrets', saveAs: 'goose-keyring.json' }`
 *  - 모든 OS: file `goose-secrets.yaml` + `goose-config.yaml`
 *
 * Goose 의 credential 저장 패턴 (crates/goose/src/config/base.rs 기반):
 *  - secrets.yaml: flat YAML 의 provider 환경변수 형식 키 (`ANTHROPIC_API_KEY: sk-ant-...`,
 *    `OPENAI_API_KEY: sk-...` 등).
 *  - config.yaml: 모델 routing / 비-secret 설정 (`GOOSE_PROVIDER__TYPE: anthropic`,
 *    `GOOSE_MODEL: claude-sonnet-4`).
 *  - macOS keychain: 위 secrets.yaml 의 내용을 단일 string payload 로 보관 (Goose 가
 *    `keyring::set_password(SERVICE, "secrets", yaml_content)` 으로 직렬화). 따라서
 *    KeychainStored.value 는 YAML 본문 그대로.
 *
 * identity 분류 (PR-H iter 1 quad-review HIGH/MED 합의 + PR-M YAML lib 도입):
 *  - **secrets.yaml / keyring**: PROVIDER_KEY_PATTERNS (known provider 명만 — generic
 *    `_TOKEN$` 제거, M2 fix) 매트릭스로 추출. 키 set 변경 → stale, 값 변경 → rotated
 *    value-only, 외 필드만 → meta-only.
 *  - **config.yaml**: CONFIG_ROUTING_KEY_PATTERNS (GOOSE_PROVIDER__TYPE/MODEL 등)
 *    매트릭스. provider 변경 → stale (M1 fix).
 *  - **양쪽 모두 매트릭스 추출 0건 + byte-diff** → low-conf rotated both (H1 fix).
 *    freshness.ts:266-277 의 empty whitelist 패턴과 대칭.
 *  - **YAML parse 실패** → low-conf 강등 (PR-M). 손상된 YAML 또는 spec 위반.
 *  - **keyring wrapper account XOR / 비-string** → stale low (H4 fix). 한쪽만 account
 *    있거나 비-string 인 케이스를 silent skip 하면 identity 안전망 우회.
 *
 * PR-M (yaml lib 도입):
 *  - 옛 간이 flat parser 는 1-depth `KEY: VALUE` 만 처리, block scalar (`|`/`>`) 와
 *    nested 구조는 감지만 하고 confidence 강등. 일부 사용자 secrets.yaml 패턴 (긴
 *    multi-line API key 가 block scalar 로 저장된 경우 등) 에서 false-positive
 *    low-conf 다발.
 *  - 본 PR: `yaml` npm lib (v2, YAML 1.2 spec) 로 교체. block scalar / quoted /
 *    anchor / alias 정식 지원. nested 구조는 여전히 top-level string-valued 키만
 *    추출 (adapter 의 매트릭스가 1-depth contract).
 *
 * 한계 명시:
 *  - 1-depth `Record<string, string>` 매트릭스 contract — nested/array/numeric/boolean
 *    값은 매트릭스 미진입. Goose 의 정형 secrets.yaml/config.yaml 패턴은 이 contract
 *    충족 (string-valued top-level).
 *  - API key 자체에 provider 신원 정보 없음 (sk-ant- prefix 외) — 같은 provider 의
 *    다른 계정 키로 swap 시 stale 못 잡고 rotated value-only 로 분류.
 *  - PROVIDER_KEY_PATTERNS / CONFIG_ROUTING_KEY_PATTERNS 는 보수적 화이트리스트 —
 *    신규 provider 추가 시 갱신 필요. fallback 으로 byte-diff 분류는 유지.
 */

import { parse as parseYaml } from 'yaml';
import { maskIdentifier } from '../errors.js';
import type { CompareResult, SourceAdapter } from '../freshness.js';
import { DANGEROUS_KEYS, parseJsonObject } from './_shared.js';

interface KeychainOuter {
  value?: unknown;
  account?: unknown;
}

/** Each provider has an explicit admission declaration. Empty field lists are
 * intentional: v1.43 source proves cache locations, not a redacted stable
 * token schema. A future field admission must update this declaration and add
 * a redacted fixture; generic JSON parsing is forbidden. */
const GOOSE_PROVIDER_CACHE_MANIFEST: Record<string, { provider: string; identityFields: readonly string[]; credentialFields: readonly string[]; metadataFields: readonly string[] }> = {
  'goose-provider-gemini-oauth-tokens.json': { provider: 'gemini', identityFields: [], credentialFields: [], metadataFields: [] },
  'goose-provider-chatgpt-codex-tokens.json': { provider: 'chatgpt-codex', identityFields: [], credentialFields: [], metadataFields: [] },
  'goose-provider-kimicode-token.json': { provider: 'kimicode', identityFields: [], credentialFields: [], metadataFields: [] },
  'goose-provider-githubcopilot.tree.json': { provider: 'githubcopilot', identityFields: [], credentialFields: [], metadataFields: [] },
  'goose-provider-xai-oauth-tokens.json': { provider: 'xai', identityFields: [], credentialFields: [], metadataFields: [] },
  'goose-provider-databricks-oauth.tree.json': { provider: 'databricks', identityFields: [], credentialFields: [], metadataFields: [] },
  'goose-provider-huggingface-oauth-tokens.json': { provider: 'huggingface', identityFields: [], credentialFields: [], metadataFields: [] }
};

/**
 * secrets.yaml / keyring 의 provider key 매트릭스 — known Goose provider env var 명만.
 *
 * generic `_TOKEN$` 제거 (M2 fix): config.yaml 의 non-provider TOKEN (DEBUG_TOKEN 등)
 * 흡수 위험 + DATABRICKS_TOKEN specific 와 중복 (L2). 새 provider 는 명시 추가.
 */
const PROVIDER_KEY_PATTERNS: RegExp[] = [
  /^ANTHROPIC_API_KEY$/,
  /^OPENAI_API_KEY$/,
  /^OPENROUTER_API_KEY$/,
  /^GOOGLE_API_KEY$/,
  /^GEMINI_API_KEY$/,
  /^GROQ_API_KEY$/,
  /^DATABRICKS_TOKEN$/,
  /^OLLAMA_API_KEY$/,
  /^REPLICATE_API_TOKEN$/,
  /^HUGGINGFACE_API_TOKEN$/,
  /_API_KEY$/    // generic suffix (secrets context — known providers + 외부 plugin 흡수)
];

/**
 * config.yaml 의 routing identity 매트릭스 (M1 fix). routing 키 매트릭스는 동일
 * 키 + 값 변경 시 그 의미가 키마다 다르다 — `GOOSE_PROVIDER__TYPE: anthropic →
 * openai` 같은 provider 전환은 다른 provider 의 다른 계정 swap 을 의미하므로
 * stale, model 만 변경은 rotation 으로 분류.
 */
const CONFIG_ROUTING_KEY_PATTERNS: RegExp[] = [
  /^GOOSE_PROVIDER__TYPE$/,
  /^GOOSE_PROVIDER$/,
  /^GOOSE_MODEL$/
];

/**
 * config.yaml 에서 값 변경 시 stale 로 분류해야 하는 routing identity 키 집합
 * (iter 2 Codex-3 #2 fix — spec/code 불일치 해소).
 *
 * `GOOSE_PROVIDER__TYPE` / `GOOSE_PROVIDER` 변경은 사용자가 다른 provider 의 다른
 * 계정으로 swap 했음을 의미 — rotation 이 아니라 identity 변경. `GOOSE_MODEL` 만
 * 변경은 동일 provider 의 model 선호도 변경이라 rotation 으로 분류.
 */
const CONFIG_STALE_ON_VALUE_CHANGE_RE = /^(GOOSE_PROVIDER__TYPE|GOOSE_PROVIDER)$/;

/** YAML 처리 결과 + parse 실패 플래그. */
interface YamlParseResult {
  /** 1-depth `KEY: string-value` 매트릭스. prototype pollution 가드 적용. */
  entries: Record<string, string>;
  /** yaml lib 가 throw 했거나 결과가 plain object 가 아닌 경우 (array/scalar 등). */
  hasParseError: boolean;
}

/**
 * `yaml` (v2, YAML 1.2 spec) 으로 raw 를 parse 후 top-level string-valued 키 추출.
 *
 * - **string-coerced primitives** (number/boolean) 은 `String(value)` 로 강제 변환 후
 *   매트릭스 진입. 옛 flat parser 시절 string 동작과 호환 — `GOOSE_MODEL: 3.5`
 *   같이 YAML number 로 해석되는 model 명이 silent skip 되어 `sameKeySet` 가
 *   비대칭 → false-positive stale 로 분류되던 회귀 차단 (PR-M quad-review HIGH/MED fix).
 * - **trailing newline 정규화**: yaml lib 의 block scalar chomping 차이 (`|` clip
 *   = `"v\n"`, `|-` strip = `"v"`) 로 동일 secret 의 chomping 마커만 다른 stored vs
 *   live 가 value-only rotation 으로 잘못 분류되던 회귀 차단. `\n+` 후행만 strip.
 * - `null` / `undefined` / nested object / array 는 매트릭스 contract (string 식별자)
 *   외이므로 skip — 향후 nested 지원 follow-up.
 * - DANGEROUS_KEYS (`__proto__`/`constructor`/`prototype`) 무조건 skip + 결과 객체는
 *   `Object.create(null)` (M3 fix — freshness.ts DANGEROUS_KEYS 와 대칭).
 * - yaml v2 의 default 는 YAML 1.2 strict parse — spec 위반 (invalid escape /
 *   닫히지 않은 quote / malformed indentation 등) 은 throw 발생 → catch 로 surface
 *   해 hasParseError 로 표시. lenient 보장 안 함 (옛 flat parser 가 silent skip
 *   하던 케이스를 yaml lib 가 throw 할 가능성 있음).
 * - **`maxAliasCount: 100`** (yaml lib default 와 동일하나 explicit 으로 lock-in) —
 *   billion laughs / YAML bomb (anchor/alias exponential expansion) 방어. 향후
 *   yaml lib default 변경에 대비.
 * - **`logLevel: 'error'`** — yaml lib 의 warning 을 stderr 로 출력하지 않도록.
 *   compare() 가 순수한 CompareResult 반환만 하고 side effect 차단 (test/CI 노이즈
 *   감소). PR-M Codex-2 iter 1 MED fix.
 * - block scalar (`|`/`>`) / quoted / anchor / alias 는 yaml lib 가 정식 해석 →
 *   resolved string value 가 entries 에 그대로 들어감 (옛 parser 의 confidence 강등 제거).
 */
function parseGooseYaml(raw: string): YamlParseResult {
  const entries = Object.create(null) as Record<string, string>;
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, { maxAliasCount: 100, logLevel: 'error' });
  } catch {
    return { entries, hasParseError: true };
  }
  // yaml.parse 가 `null` 반환 = 빈 문서 또는 only-comment.
  if (parsed === null || parsed === undefined) {
    return { entries, hasParseError: false };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    // top-level scalar / array — Goose 의 정형 패턴 외 → parse 실패로 surface.
    return { entries, hasParseError: true };
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (!key || DANGEROUS_KEYS.has(key)) continue;
    const coerced = coerceToIdentityString(value);
    if (coerced === null) continue;
    // trailing newline strip — block scalar chomping 차이로 동일 secret 가 다르게
    // 보이지 않도록 정규화. 본문 내부 newline 은 유지 (multi-line key 가능성).
    entries[key] = coerced.replace(/\n+$/, '');
  }
  return { entries, hasParseError: false };
}

/**
 * top-level value 를 identity 비교용 string 으로 강제. 매트릭스 contract (1-depth
 * string) 외 (nested object / array / null / undefined) 는 null 반환 → skip.
 *
 * primitive (number / boolean / bigint) 은 `String()` 으로 강제 — YAML 1.2 spec 의
 * scalar tag resolution (e.g. `3.5` → number) 으로 인한 silent skip 차단. 옛 flat
 * parser 시절 string 으로 보존되던 패턴과 호환.
 */
function coerceToIdentityString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function extractByPatterns(
  parsed: Record<string, string>,
  patterns: RegExp[]
): Record<string, string> {
  const out = Object.create(null) as Record<string, string>;
  for (const [key, val] of Object.entries(parsed)) {
    if (patterns.some((p) => p.test(key))) {
      out[key] = val;
    }
  }
  return out;
}

function sameKeySet(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  return ak.every((k) => k in b);
}

/**
 * 추출된 매트릭스 (provider keys 또는 routing keys) 의 식별 비교.
 *
 * 빈 매트릭스 (양쪽 모두 0건) 케이스는 caller 가 별도 분기 (H1 fix). 본 함수는
 * 양쪽 모두 최소 1건 추출됐을 때만 호출.
 *
 * `staleOnValueChangeRe` (iter 2 Codex-3 #2 fix): config.yaml 의
 * `GOOSE_PROVIDER__TYPE` 같이 값 변경 자체가 identity 변경을 의미하는 키 집합.
 * 매칭되는 키 중 하나라도 값이 다르면 rotation 이 아닌 stale 로 분류.
 * provider 매트릭스는 staleOnValueChangeRe=undefined — 키 값 변경은 단순 rotation
 * (API key rotation 등).
 */
function compareIdentityMatrix(
  sIds: Record<string, string>,
  lIds: Record<string, string>,
  label: string,
  staleOnValueChangeRe?: RegExp
): CompareResult {
  if (!sameKeySet(sIds, lIds)) {
    const sKeys = Object.keys(sIds).sort().join(',') || '<none>';
    const lKeys = Object.keys(lIds).sort().join(',') || '<none>';
    return {
      kind: 'stale',
      confidence: 'medium',
      detail: `${label} 키 set 변경: ${maskIdentifier(sKeys)} → ${maskIdentifier(lKeys)}`
    };
  }
  if (staleOnValueChangeRe) {
    const identityChange = Object.keys(sIds).find(
      (k) => staleOnValueChangeRe.test(k) && sIds[k] !== lIds[k]
    );
    if (identityChange) {
      return {
        kind: 'stale',
        confidence: 'medium',
        detail: `${label} identity 키 '${identityChange}' 값 변경 — 다른 provider/계정 swap 추정`
      };
    }
  }
  const valueChanged = Object.keys(sIds).some((k) => sIds[k] !== lIds[k]);
  if (valueChanged) {
    return {
      kind: 'rotated',
      subtype: 'value-only',
      confidence: 'medium',
      detail: `${label} 키 set 동일, 값 변경 (rotation 추정)`
    };
  }
  return {
    kind: 'rotated',
    subtype: 'meta-only',
    confidence: 'medium',
    detail: `${label} 키 동일, 외 필드만 변경`
  };
}

/**
 * YAML 본문 비교 — secrets.yaml / keyring 또는 config.yaml. saveAs 에 따라 매트릭스
 * 분기. parse 실패 시 모든 분류 confidence 강등.
 */
function compareGooseYaml(saveAs: string, stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const sParsed = parseGooseYaml(stored);
  const lParsed = parseGooseYaml(live);
  const isConfig = saveAs === 'goose-config.yaml';
  const patterns = isConfig ? CONFIG_ROUTING_KEY_PATTERNS : PROVIDER_KEY_PATTERNS;
  const label = isConfig ? 'routing' : 'provider';
  const staleOnChange = isConfig ? CONFIG_STALE_ON_VALUE_CHANGE_RE : undefined;
  const sIds = extractByPatterns(sParsed.entries, patterns);
  const lIds = extractByPatterns(lParsed.entries, patterns);
  const parseFailed = sParsed.hasParseError || lParsed.hasParseError;
  if (Object.keys(sIds).length === 0 && Object.keys(lIds).length === 0) {
    return emptyMatrixVerdict(parseFailed, label);
  }
  const verdict = compareIdentityMatrix(sIds, lIds, label, staleOnChange);
  if (parseFailed) {
    return downgradeForParseError(verdict);
  }
  return verdict;
}

/**
 * 매트릭스 추출이 양쪽 모두 0건 (H1 fix). byte-diff 가 있지만 어떤 식별 키도 매치
 * 안 되므로 자격증명 변경 여부 불확실 → low-conf rotated both. freshness.ts:266-277
 * 의 fallback 패턴과 대칭.
 */
function emptyMatrixVerdict(parseFailed: boolean, label: string): CompareResult {
  const hint = parseFailed ? ' + YAML parse 실패' : '';
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'low',
    detail: `Goose YAML: ${label} 키 미감지${hint} — byte 비교만`
  };
}

/**
 * YAML parse 실패 시 confidence 강등 (PR-M). yaml lib 가 spec 위반 (invalid escape,
 * 닫히지 않은 quote, malformed indentation 등) 으로 throw 한 경우 — 매트릭스
 * 추출이 부분적이거나 stale 한 데이터일 수 있어 신뢰도 낮춤.
 */
function downgradeForParseError(verdict: CompareResult): CompareResult {
  const hint = ' (YAML parse 실패 — 손상된 YAML 또는 spec 위반)';
  return {
    ...verdict,
    confidence: 'low',
    detail: `${verdict.detail ?? ''}${hint}`
  };
}

/**
 * macOS keyring 의 KeychainStored wrapper 비교. wrapper 검증 → inner YAML 비교 위임.
 *
 * account 안전망 (H4 fix):
 *  - 양쪽 모두 string 이고 다름 → stale (high).
 *  - 한쪽만 string (XOR) → stale (low). wrapper 손상 추정.
 *  - 양쪽 모두 비-string (의도된 wrapper 형식 외) → wrapper 손상 보고.
 */
function compareGooseKeyring(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const sOuter = parseJsonObject<KeychainOuter>(stored);
  const lOuter = parseJsonObject<KeychainOuter>(live);
  if (!sOuter || !lOuter) {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'Goose keyring KeychainStored wrapper parse 실패'
    };
  }
  if (typeof sOuter.value !== 'string' || typeof lOuter.value !== 'string') {
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: 'Goose keyring inner value 부재 또는 비-문자열'
    };
  }
  const accountVerdict = compareKeyringAccount(sOuter.account, lOuter.account);
  if (accountVerdict) return accountVerdict;
  // keyring inner value 는 secrets.yaml 본문 가정 — 동일 매트릭스 사용.
  return compareGooseYaml('goose-secrets.yaml', sOuter.value, lOuter.value);
}

/**
 * KeychainStored.account 의 identity 검사 (H4 + iter 2 Codex-3 #3 정밀화).
 *
 * 존재 판정은 `typeof === 'string'` — 빈 문자열 `''` 도 유효 string. 이전
 * truthiness 는 `''` 를 absent 로 잘못 분류해 XOR 우회 가능.
 *
 * 분기 (mutually exclusive):
 *  - 양쪽 모두 string + 다름 → stale (high).
 *  - 양쪽 모두 string + 동일 → null (inner value 비교 위임).
 *  - 한쪽만 string (XOR) → stale (low). wrapper 손상.
 *  - 양쪽 모두 비-string → stale (low). 정의된 wrapper 형식 (account 필드 string)
 *    이 아닌 손상 — 양쪽 모두 wrapper damage 로 surface (이전엔 silent skip).
 */
function compareKeyringAccount(s: unknown, l: unknown): CompareResult | null {
  const sIsString = typeof s === 'string';
  const lIsString = typeof l === 'string';
  if (sIsString && lIsString) {
    if (s !== l) {
      return {
        kind: 'stale',
        confidence: 'high',
        detail: `Keychain account 변경: ${maskIdentifier(s as string)} → ${maskIdentifier(l as string)}`
      };
    }
    return null;
  }
  if (sIsString !== lIsString) {
    return {
      kind: 'stale',
      confidence: 'low',
      detail: 'KeychainStored.account 비대칭 — keyring 손상 추정'
    };
  }
  // 양쪽 모두 비-string — Goose keyring wrapper 가 account 를 항상 string 으로
  // 가져야 한다는 contract 위반. iter 2 Codex-3 #3 fix: 이전엔 null 반환으로
  // silent skip 됐으나 wrapper damage 로 surface.
  if (s !== undefined || l !== undefined) {
    return {
      kind: 'stale',
      confidence: 'low',
      detail: 'KeychainStored.account 양쪽 모두 비-string — keyring 손상 추정'
    };
  }
  return null;
}

export const gooseAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs === 'goose-keyring.json') {
      return compareGooseKeyring(stored, live);
    }
    if (saveAs === 'goose-secrets.yaml' || saveAs === 'goose-config.yaml') {
      return compareGooseYaml(saveAs, stored, live);
    }
    if (GOOSE_PROVIDER_CACHE_MANIFEST[saveAs]) {
      // v1.43 source proves location, not a durable redacted field schema for
      // every cache. Do not invent token claims: opaque differences demand
      // user attention rather than an account-change assertion.
      return stored === live
        ? { kind: 'fresh', confidence: 'high' }
        : { kind: 'rotated', subtype: 'both', confidence: 'low', detail: 'Goose provider cache changed (opaque v1.43 admission)' };
    }
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: `Goose adapter: 미지원 source ${saveAs}`
    };
  }
};
