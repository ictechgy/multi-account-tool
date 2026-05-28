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
 * identity 분류:
 *  - **goose-keyring.json**: KeychainStored wrapper outer parse → account 변경 시 stale.
 *    inner value 는 YAML → 아래 YAML 비교 로직 위임.
 *  - **goose-secrets.yaml / goose-config.yaml**: provider key 매트릭스로 추출 후 비교.
 *    - 키 set 변경 → stale (다른 provider 추가/제거, 다른 계정 추정)
 *    - 키 set 동일 + 값 변경 → rotated value-only (API key rotation 또는 다른 키 값)
 *    - 키 set+값 동일 + 외 필드 변경 → rotated meta-only (routing/cache 변경)
 *
 * 한계 명시:
 *  - 간이 flat YAML parser — 1-depth `KEY: VALUE` 라인만 처리. Goose 의 secrets.yaml
 *    구조는 일반적으로 flat (env var 형식) 이므로 충분. config.yaml 의 nested
 *    구조 (providers tree 등) 는 top-level key 만 비교 — 누락된 nested 차이는
 *    fallback (byte hash mismatch) 으로 떨어져 rotated 로 분류.
 *  - API key 자체에 provider 신원 정보 없음 (sk-ant- prefix 외) — 같은 provider 의
 *    다른 계정 키로 swap 시 stale 못 잡고 rotated value-only 로 분류.
 *  - yaml 정식 spec (anchors / multiline / quoted) 미지원. Goose 의 실제 사용 패턴
 *    범위 내에서만 신뢰 가능.
 */

import { maskIdentifier } from '../errors.js';
import type { CompareResult, SourceAdapter } from '../freshness.js';

interface KeychainOuter {
  value?: unknown;
  account?: unknown;
}

/** provider key 휴리스틱 — Goose 의 known provider 환경변수 명. */
const PROVIDER_KEY_PATTERNS: RegExp[] = [
  /^ANTHROPIC_API_KEY$/,
  /^OPENAI_API_KEY$/,
  /^OPENROUTER_API_KEY$/,
  /^GOOGLE_API_KEY$/,
  /^GEMINI_API_KEY$/,
  /^GROQ_API_KEY$/,
  /^DATABRICKS_TOKEN$/,
  /^OLLAMA_API_KEY$/,
  /_API_KEY$/,    // generic suffix
  /_TOKEN$/       // generic suffix (DATABRICKS_TOKEN 등 흡수)
];

/**
 * 간이 flat YAML parser — `KEY: VALUE` 라인 1-depth 만 추출.
 *
 * - `#` 로 시작하는 라인 (주석) 무시.
 * - 빈 라인 무시.
 * - 들여쓰기된 라인 (nested) 은 top-level 아니므로 skip.
 * - VALUE 의 양옆 single/double quote 1쌍은 strip (Goose 가 보통 unquoted 으로 저장).
 */
function parseFlatYaml(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = stripQuotes(trimmed.slice(colonIdx + 1).trim());
    if (!key) continue;
    out[key] = value;
  }
  return out;
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

function extractProviderSecrets(parsed: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(parsed)) {
    if (PROVIDER_KEY_PATTERNS.some((p) => p.test(key))) {
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

function compareGooseYaml(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }
  const sParsed = parseFlatYaml(stored);
  const lParsed = parseFlatYaml(live);
  const sSecrets = extractProviderSecrets(sParsed);
  const lSecrets = extractProviderSecrets(lParsed);
  if (!sameKeySet(sSecrets, lSecrets)) {
    const sKeys = Object.keys(sSecrets).sort().join(',') || '<none>';
    const lKeys = Object.keys(lSecrets).sort().join(',') || '<none>';
    return {
      kind: 'stale',
      confidence: 'medium',
      detail: `provider 키 set 변경: ${maskIdentifier(sKeys)} → ${maskIdentifier(lKeys)}`
    };
  }
  const valueChanged = Object.keys(sSecrets).some((k) => sSecrets[k] !== lSecrets[k]);
  if (valueChanged) {
    return {
      kind: 'rotated',
      subtype: 'value-only',
      confidence: 'medium',
      detail: 'provider 키 set 동일, API key 값 변경 (rotation 추정)'
    };
  }
  return {
    kind: 'rotated',
    subtype: 'meta-only',
    confidence: 'medium',
    detail: 'provider 키 동일, routing/기타 필드만 변경'
  };
}

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
  if (
    typeof sOuter.account === 'string' &&
    typeof lOuter.account === 'string' &&
    sOuter.account !== lOuter.account
  ) {
    return {
      kind: 'stale',
      confidence: 'high',
      detail: `Keychain account 변경: ${maskIdentifier(sOuter.account)} → ${maskIdentifier(lOuter.account)}`
    };
  }
  return compareGooseYaml(sOuter.value, lOuter.value);
}

function parseJsonObject<T>(raw: string): T | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    return v as T;
  } catch {
    return null;
  }
}

export const gooseAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (saveAs === 'goose-keyring.json') {
      return compareGooseKeyring(stored, live);
    }
    if (saveAs === 'goose-secrets.yaml' || saveAs === 'goose-config.yaml') {
      return compareGooseYaml(stored, live);
    }
    return {
      kind: 'rotated',
      subtype: 'both',
      confidence: 'low',
      detail: `Goose adapter: 미지원 source ${saveAs}`
    };
  }
};
