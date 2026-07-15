/**
 * Crush (Charm.sh) freshness adapter.
 *
 * Upstream pin (captured 2026-07-15 KST):
 *   charmbracelet/crush@7b24cc09987337de8bdab1f8b78430efb00337b8
 *
 * Persisted OAuth shape (`providers.<provider>.oauth`):
 *   access_token:string, refresh_token:string, expires_in:integer, expires_at:integer
 * No additional properties. No stable non-secret account identity is persisted.
 *
 * Only Hyper and Copilot store refreshable OAuth at this pin. Login aliases
 * `github` / `github-copilot` normalize to stored `copilot` upstream and are
 * not admitted as independent provider keys.
 *
 * Identity rule (G003):
 *   Only a separately admitted stable non-secret field may prove same-account
 *   continuity. The current pin has none (`CRUSH_IDENTITY_FIELDS` is empty), so
 *   every changed source uses low-confidence `rotated:both` as an **unsafe
 *   byte-diff transport** — never a confirmed rotation and never same-identity.
 *
 * Result-model boundary:
 *   - equal raw bytes → fresh / high (before schema parse)
 *   - any difference (admitted OAuth, static-only, malformed, unknown provider,
 *     provider-map mismatch, mirror inconsistency, unsupported saveAs) →
 *     rotated / both / low with identity-unknown wording
 *   - missing source remains the existing freshness.ts stale path
 *
 * Source-local boundary:
 *   `crush-config.json` and `crush-data.json` are compared independently. Normal
 *   Hyper/Copilot login may store OAuth plus a mirrored `api_key` in the same
 *   provider object; coexistence is accepted but never proves identity and is
 *   never validated as cross-file coherence.
 *
 * Never emit access/refresh/API-key values, digests, or raw identity material
 * in detail strings.
 */

import type { CompareResult, SourceAdapter } from '../freshness.js';
import { DANGEROUS_KEYS, parseJsonObject } from './_shared.js';

/** Crush profile saveAs names from cli-defs (unchanged source locations). */
const CRUSH_SAVE_AS = new Set(['crush-config.json', 'crush-data.json']);

/**
 * Provider keys admitted for known OAuth shape at the current pin.
 * Aliases (github / github-copilot) are not stored keys and are not admitted.
 */
const ADMITTED_OAUTH_PROVIDERS: ReadonlySet<string> = new Set(['hyper', 'copilot']);

/**
 * Exact OAuth object fields from the pin schema. Values are never emitted.
 */
const OAUTH_REQUIRED_FIELDS = [
  'access_token',
  'refresh_token',
  'expires_in',
  'expires_at'
] as const;

/**
 * Stable non-secret identity fields that would allow high-confidence rotation.
 * Intentionally empty at this pin — do not invent identity from provider key,
 * token, expiry, api_key, base URL, or transient upstream responses.
 */
export const CRUSH_IDENTITY_FIELDS: readonly string[] = [];

/** Conservative detail for every changed Crush source (identity unavailable). */
const BYTE_DIFF_DETAIL =
  'Crush OAuth: identity unknown; conservative byte-diff (no confirmed rotation)';

/**
 * Finite integer check for OAuth expires_in / expires_at.
 * No semantic range is inferred; negative/zero meaning is upstream-owned.
 */
function isFiniteInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && Number.isFinite(value);
}

/**
 * Own-key enumeration only — never walk prototypes / inherited keys.
 */
function ownKeys(obj: object): string[] {
  return Object.keys(obj).filter((k) => !DANGEROUS_KEYS.has(k));
}

/**
 * Admit an OAuth object only when it has exactly the four pin-required fields
 * with the correct types and no extra own keys.
 *
 * Counts all enumerable own keys (including __proto__, constructor, prototype)
 * so a JSON-parsed payload carrying a dangerous own key is rejected.
 */
export function isAdmittedOauthShape(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const totalOwnKeys = Object.keys(value).length;
  if (totalOwnKeys !== OAUTH_REQUIRED_FIELDS.length) return false;
  for (const field of OAUTH_REQUIRED_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.access_token !== 'string') return false;
  if (typeof rec.refresh_token !== 'string') return false;
  if (!isFiniteInteger(rec.expires_in)) return false;
  if (!isFiniteInteger(rec.expires_at)) return false;
  return true;
}

/**
 * Whether high-confidence OAuth rotation can be asserted under current admission.
 * Locked false while identity fields remain empty.
 */
export function canConfirmOauthRotation(): boolean {
  return CRUSH_IDENTITY_FIELDS.length > 0;
}

/**
 * Low-confidence unsafe byte-diff transport shared by every changed path.
 */
function unsafeByteDiff(detail: string = BYTE_DIFF_DETAIL): CompareResult {
  return {
    kind: 'rotated',
    subtype: 'both',
    confidence: 'low',
    detail
  };
}

/**
 * Closed-world scan: true if any admitted provider owns a pin-shaped oauth object.
 * Used by tests and as the extension point before identity-backed rotation is ever enabled.
 */
export function findAdmittedOauthProviders(raw: string): string[] {
  const root = parseJsonObject<{ providers?: unknown }>(raw);
  if (!root) return [];
  const providers = root.providers;
  if (providers === null || typeof providers !== 'object' || Array.isArray(providers)) {
    return [];
  }
  const found: string[] = [];
  for (const key of ownKeys(providers)) {
    if (!ADMITTED_OAUTH_PROVIDERS.has(key)) continue;
    const entry = (providers as Record<string, unknown>)[key];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (isAdmittedOauthShape((entry as Record<string, unknown>).oauth)) {
      found.push(key);
    }
  }
  return found;
}

/**
 * Compare two Crush JSON sources.
 *
 * Equal raw bytes → fresh/high. Any difference → low-confidence rotated:both.
 * Pin admission helpers (`isAdmittedOauthShape`, `findAdmittedOauthProviders`,
 * `canConfirmOauthRotation`, `CRUSH_ADMISSION`) remain exported for tests and
 * future identity evidence; they do not change this conservative compare path
 * while `CRUSH_IDENTITY_FIELDS` is empty. Enabling confirmed rotation requires
 * re-plan + non-empty identity admission, not a silent compare-side branch.
 */
function compareCrush(stored: string, live: string): CompareResult {
  if (stored === live) {
    return { kind: 'fresh', confidence: 'high' };
  }

  return unsafeByteDiff(BYTE_DIFF_DETAIL);
}

export const crushAdapter: SourceAdapter = {
  compare(saveAs, stored, live) {
    if (!CRUSH_SAVE_AS.has(saveAs)) {
      return unsafeByteDiff(`Crush adapter: unsupported source ${saveAs}`);
    }
    return compareCrush(stored, live);
  }
};

/** Test/export surface: pin admission constants (no secret values). */
export const CRUSH_ADMISSION = {
  pin: 'charmbracelet/crush@7b24cc09987337de8bdab1f8b78430efb00337b8',
  retrievedDateKst: '2026-07-15',
  admittedOauthProviders: ADMITTED_OAUTH_PROVIDERS,
  oauthRequiredFields: OAUTH_REQUIRED_FIELDS,
  identityFields: CRUSH_IDENTITY_FIELDS,
  saveAs: CRUSH_SAVE_AS
} as const;
