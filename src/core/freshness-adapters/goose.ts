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
 * identity 분류 (PR-H iter 1 quad-review HIGH/MED 합의 반영):
 *  - **secrets.yaml / keyring**: PROVIDER_KEY_PATTERNS (known provider 명만 — generic
 *    `_TOKEN$` 제거, M2 fix) 매트릭스로 추출. 키 set 변경 → stale, 값 변경 → rotated
 *    value-only, 외 필드만 → meta-only.
 *  - **config.yaml**: CONFIG_ROUTING_KEY_PATTERNS (GOOSE_PROVIDER__TYPE/MODEL 등)
 *    매트릭스. provider 변경 → stale (M1 fix).
 *  - **양쪽 모두 매트릭스 추출 0건 + byte-diff** → low-conf rotated both (H1 fix).
 *    freshness.ts:266-277 의 empty whitelist 패턴과 대칭.
 *  - **block scalar (`|` / `>`) 감지** → low-conf 강등 (H2 fix). flat parser 가
 *    indent 라인을 skip 하므로 secret 값이 silent 손실될 위험.
 *  - **keyring wrapper account XOR / 비-string** → stale low (H4 fix). 한쪽만 account
 *    있거나 비-string 인 케이스를 silent skip 하면 identity 안전망 우회.
 *
 * 한계 명시:
 *  - 간이 flat YAML parser — 1-depth `KEY: VALUE` 라인만 처리. block scalar 와 nested
 *    구조는 감지만 하고 분류 confidence 강등 (H2 fix). 완전한 YAML 정합성은 yaml
 *    lib 도입 follow-up.
 *  - API key 자체에 provider 신원 정보 없음 (sk-ant- prefix 외) — 같은 provider 의
 *    다른 계정 키로 swap 시 stale 못 잡고 rotated value-only 로 분류.
 *  - PROVIDER_KEY_PATTERNS / CONFIG_ROUTING_KEY_PATTERNS 는 보수적 화이트리스트 —
 *    신규 provider 추가 시 갱신 필요. fallback 으로 byte-diff 분류는 유지.
 */

import { maskIdentifier } from '../errors.js';
import type { CompareResult, SourceAdapter } from '../freshness.js';
import { DANGEROUS_KEYS, parseJsonObject } from './_shared.js';

interface KeychainOuter {
  value?: unknown;
  account?: unknown;
}

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
 * config.yaml 의 routing identity 매트릭스 (M1 fix). provider type 변경은 routing
 * identity 의 핵심 — 다른 provider 의 다른 계정으로 swap 됐다는 의미. stale 분류.
 */
const CONFIG_ROUTING_KEY_PATTERNS: RegExp[] = [
  /^GOOSE_PROVIDER__TYPE$/,
  /^GOOSE_PROVIDER$/,
  /^GOOSE_MODEL$/
];

/**
 * block scalar 마커 (`|` 또는 `>`) 가 단독 value 인 라인 패턴 (H2 fix).
 * 예: `ANTHROPIC_API_KEY: |` — flat parser 가 다음 indent 라인의 secret 본문을
 * skip 하므로 비교 신뢰도 손상.
 */
const BLOCK_SCALAR_VALUE_RE = /^\s*[|>][+-]?\s*$/;

/** 간이 flat YAML 처리 결과 + block scalar 감지 플래그. */
interface YamlParseResult {
  /** 1-depth `KEY: VALUE` 매트릭스. prototype pollution 가드 적용 (Object.create(null)). */
  entries: Record<string, string>;
  /** YAML 본문에 block scalar (`|`/`>`) value 가 1줄이라도 등장하면 true. */
  hasBlockScalar: boolean;
}

/**
 * 간이 flat YAML parser — `KEY: VALUE` 라인 1-depth 만 추출.
 *
 * - `#` 로 시작하는 라인 (주석) 무시.
 * - 빈 라인 무시.
 * - 들여쓰기된 라인 (nested) 은 top-level 아니므로 skip.
 * - VALUE 의 양옆 single/double quote 1쌍은 strip (Goose 가 보통 unquoted 으로 저장).
 * - block scalar value (`|`/`>`) 가 등장하면 `hasBlockScalar=true` — caller 가
 *   confidence 강등에 사용 (H2 fix).
 * - DANGEROUS_KEYS (`__proto__`/`constructor`/`prototype`) 는 무조건 skip + 결과
 *   객체는 `Object.create(null)` (M3 fix — freshness.ts DANGEROUS_KEYS 와 대칭).
 */
function parseFlatYaml(raw: string): YamlParseResult {
  const entries = Object.create(null) as Record<string, string>;
  let hasBlockScalar = false;
  for (const line of raw.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1);
    if (!key || DANGEROUS_KEYS.has(key)) continue;
    if (BLOCK_SCALAR_VALUE_RE.test(rawValue)) {
      hasBlockScalar = true;
    }
    entries[key] = stripQuotes(rawValue.trim());
  }
  return { entries, hasBlockScalar };
}

function stripQuotes(v: string): string {
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return v.slice(1, -1);
    }
  }
  return v;
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
 */
function compareIdentityMatrix(
  sIds: Record<string, string>,
  lIds: Record<string, string>,
  label: string
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
 * 분기. block scalar 감지 시 모든 분류 confidence 강등 (H2 fix).
 */
function compareGooseYaml(saveAs: string, stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const sParsed = parseFlatYaml(stored);
  const lParsed = parseFlatYaml(live);
  const patterns =
    saveAs === 'goose-config.yaml' ? CONFIG_ROUTING_KEY_PATTERNS : PROVIDER_KEY_PATTERNS;
  const label = saveAs === 'goose-config.yaml' ? 'routing' : 'provider';
  const sIds = extractByPatterns(sParsed.entries, patterns);
  const lIds = extractByPatterns(lParsed.entries, patterns);
  if (Object.keys(sIds).length === 0 && Object.keys(lIds).length === 0) {
    return emptyMatrixVerdict(sParsed.hasBlockScalar || lParsed.hasBlockScalar, label);
  }
  const verdict = compareIdentityMatrix(sIds, lIds, label);
  if (sParsed.hasBlockScalar || lParsed.hasBlockScalar) {
    return downgradeForBlockScalar(verdict);
  }
  return verdict;
}

/**
 * 매트릭스 추출이 양쪽 모두 0건 (H1 fix). byte-diff 가 있지만 어떤 식별 키도 매치
 * 안 되므로 자격증명 변경 여부 불확실 → low-conf rotated both. freshness.ts:266-277
 * 의 fallback 패턴과 대칭.
 */
function emptyMatrixVerdict(hasBlockScalar: boolean, label: string): CompareResult {
  const blockHint = hasBlockScalar ? ' + block scalar 감지' : '';
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'low',
    detail: `Goose YAML: ${label} 키 미감지${blockHint} — flat YAML 한계, byte 비교만`
  };
}

/**
 * block scalar (`|`/`>`) 감지 시 confidence 강등 — flat parser 가 indent 라인을 skip
 * 하므로 secret 본문이 silent 손실 가능 (H2 fix). caller 가 산정한 verdict 의
 * confidence 만 'low' 로 낮추고 detail 에 hint 추가.
 */
function downgradeForBlockScalar(verdict: CompareResult): CompareResult {
  const hint = ' (block scalar `|`/`>` 감지 — flat parser 한계, 분류 신뢰도 강등)';
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

function compareKeyringAccount(s: unknown, l: unknown): CompareResult | null {
  const sStr = typeof s === 'string' ? s : null;
  const lStr = typeof l === 'string' ? l : null;
  if (sStr && lStr) {
    if (sStr !== lStr) {
      return {
        kind: 'stale',
        confidence: 'high',
        detail: `Keychain account 변경: ${maskIdentifier(sStr)} → ${maskIdentifier(lStr)}`
      };
    }
    return null;
  }
  if (sStr || lStr) {
    return {
      kind: 'stale',
      confidence: 'low',
      detail: 'KeychainStored.account 비대칭 — keyring 손상 추정'
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
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: `Goose adapter: 미지원 source ${saveAs}`
    };
  }
};
