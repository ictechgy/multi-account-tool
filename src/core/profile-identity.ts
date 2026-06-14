/**
 * Capture-time profile identity metadata.
 *
 * This module may inspect credential bytes only when callers already have them
 * during capture/recapture. Read-only surfaces (`status`, `doctor`, `support`)
 * must consume only normalized metadata from `meta.json`.
 */

import { parse as parseYaml } from 'yaml';

import { maskIdentifier, redactMessage } from './errors.js';
import { parseJsonObject } from './freshness-adapters/_shared.js';
import type {
  ProfileIdentityCompleteness,
  ProfileIdentityConfidence,
  ProfileIdentitySignal,
  ProfileIdentitySignalKind,
  ProfileIdentityStatus,
  ProfileIdentitySummary,
  ProfileIdentityWarning,
  ProfileIdentityWarningCode
} from './types.js';

export type IdentitySourceState = 'captured' | 'carried-forward' | 'missing';

export interface IdentitySourceInput {
  saveAs: string;
  value: string | null;
  state: IdentitySourceState;
}

export interface BuildProfileIdentityInput {
  cliId: string;
  capturedAt: Date;
  sources: IdentitySourceInput[];
  lockHeld?: boolean;
}

export interface ProfileIdentityCapability {
  status: ProfileIdentityStatus;
  signals: Array<{ kind: ProfileIdentitySignalKind; source: string; safety: 'masked' | 'allowlisted' | 'mode-only' }>;
  caveats: string[];
}

const IDENTITY_SCHEMA_VERSION = 1 as const;
const FINGERPRINT_RE = /^<hash:[0-9a-f]{12}>$/;
const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SAFE_SOURCE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SAFE_VALUE_RE = /^[A-Za-z0-9._:-]{1,40}$/;
const EMAILISH_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/;

const PROVIDER_VALUES = new Set([
  'anthropic',
  'openai',
  'openrouter',
  'google',
  'gemini',
  'groq',
  'ollama',
  'replicate',
  'huggingface',
  'databricks',
  'qwen',
  'kimi'
]);

const SUBSCRIPTION_VALUES = new Set(['claudeai', 'claudepro', 'max', 'enterprise', 'team', 'pro', 'free']);
const AUTH_MODE_VALUES = new Set(['chatgpt', 'oauth', 'api-key']);
const PROVIDER_KEY_RE = /^(ANTHROPIC|OPENAI|OPENROUTER|GOOGLE|GEMINI|GROQ|DATABRICKS|OLLAMA|REPLICATE|HUGGINGFACE)_/;

function isoString(date: Date): string {
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

export function normalizeIsoString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? value : undefined;
}

function safeSource(source: string): string {
  return SAFE_SOURCE_RE.test(source) ? source : 'unknown';
}

function warning(code: ProfileIdentityWarningCode, source?: string): ProfileIdentityWarning {
  return source ? { code, source: safeSource(source) } : { code };
}

function signal(
  kind: ProfileIdentitySignalKind,
  source: string,
  confidence: ProfileIdentityConfidence,
  extra: Pick<ProfileIdentitySignal, 'fingerprint' | 'value'> = {}
): ProfileIdentitySignal {
  return { kind, source: safeSource(source), confidence, ...extra };
}

function fingerprintSignal(
  kind: ProfileIdentitySignalKind,
  source: string,
  confidence: ProfileIdentityConfidence,
  raw: string
): ProfileIdentitySignal {
  return signal(kind, source, confidence, { fingerprint: maskIdentifier(raw) });
}

function allowlistedValue(raw: unknown, allowed: Set<string>): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return allowed.has(value) ? value : undefined;
}

function safeProviderValue(raw: string): Pick<ProfileIdentitySignal, 'fingerprint' | 'value'> {
  const value = raw.trim().toLowerCase();
  if (PROVIDER_VALUES.has(value)) return { value };
  return { fingerprint: maskIdentifier(raw) };
}

function collectWarnings(sources: IdentitySourceInput[], lockHeld: boolean | undefined): ProfileIdentityWarning[] {
  const warnings = sources.flatMap((src) => {
    if (src.state === 'carried-forward') return [warning('carried-forward', src.saveAs)];
    if (src.state === 'missing') return [warning('missing-source', src.saveAs)];
    return [];
  });
  if (lockHeld === false) warnings.push(warning('lock-free-recapture'));
  return warnings;
}

function completenessFor(sources: IdentitySourceInput[]): ProfileIdentityCompleteness {
  if (sources.length === 0) return 'unknown';
  if (sources.every((src) => src.state === 'captured' && src.value !== null)) return 'complete';
  return sources.some((src) => src.value !== null) ? 'partial' : 'unknown';
}

function finalizeIdentity(
  capturedAt: Date,
  completeness: ProfileIdentityCompleteness,
  signals: ProfileIdentitySignal[],
  warnings: ProfileIdentityWarning[]
): ProfileIdentitySummary {
  const status = signals.length > 0 ? 'available' : 'unavailable';
  const allWarnings = signals.length > 0 ? warnings : [...warnings, warning('no-identity')];
  return {
    schemaVersion: IDENTITY_SCHEMA_VERSION,
    status,
    capturedAt: isoString(capturedAt),
    completeness,
    signals,
    ...(allWarnings.length > 0 ? { warnings: allWarnings } : {})
  };
}

function valueOf(sources: IdentitySourceInput[], saveAs: string): string | null {
  return sources.find((src) => src.saveAs === saveAs)?.value ?? null;
}

export function buildProfileIdentity(input: BuildProfileIdentityInput): ProfileIdentitySummary {
  const completeness = completenessFor(input.sources);
  const warnings = collectWarnings(input.sources, input.lockHeld);
  const signals = buildSignals(input.cliId, input.sources, warnings);
  return finalizeIdentity(input.capturedAt, completeness, signals, warnings);
}

function buildSignals(
  cliId: string,
  sources: IdentitySourceInput[],
  warnings: ProfileIdentityWarning[]
): ProfileIdentitySignal[] {
  switch (cliId) {
    case 'codex':
      return codexSignals(valueOf(sources, 'auth.json'), warnings);
    case 'gemini':
      return geminiSignals(valueOf(sources, 'google_accounts.json'), warnings);
    case 'claude':
      return claudeSignals(valueOf(sources, 'credentials.json'), warnings);
    case 'opencode':
      return opencodeSignals(valueOf(sources, 'opencode-auth.json'), warnings);
    case 'goose':
      return gooseSignals(sources, warnings);
    default:
      warnings.push(warning('unsupported'));
      return [];
  }
}

interface CodexAuth {
  tokens?: { account_id?: string };
  auth_mode?: string;
  OPENAI_API_KEY?: string | null;
}

function codexSignals(raw: string | null, warnings: ProfileIdentityWarning[]): ProfileIdentitySignal[] {
  if (raw === null) return [];
  const parsed = parseJsonObject<CodexAuth>(raw);
  if (!parsed) {
    warnings.push(warning('parse-error', 'auth.json'));
    return [];
  }
  const out: ProfileIdentitySignal[] = [];
  if (typeof parsed.tokens?.account_id === 'string') {
    out.push(fingerprintSignal('account', 'auth.json', 'high', parsed.tokens.account_id));
  }
  const mode = allowlistedValue(parsed.auth_mode, AUTH_MODE_VALUES);
  if (mode) out.push(signal('auth-mode', 'auth.json', 'medium', { value: mode }));
  if (parsed.OPENAI_API_KEY) out.push(signal('api-key-mode', 'auth.json', 'medium'));
  return out;
}

interface GoogleAccounts {
  active?: string;
}

function geminiSignals(raw: string | null, warnings: ProfileIdentityWarning[]): ProfileIdentitySignal[] {
  if (raw === null) return [];
  const parsed = parseJsonObject<GoogleAccounts>(raw);
  if (!parsed) {
    warnings.push(warning('parse-error', 'google_accounts.json'));
    return [];
  }
  return typeof parsed.active === 'string'
    ? [fingerprintSignal('email', 'google_accounts.json', 'high', parsed.active)]
    : [];
}

interface KeychainOuter {
  value?: unknown;
  account?: unknown;
}

interface ClaudeCredentials {
  claudeAiOauth?: { subscriptionType?: string };
}

function claudeSignals(raw: string | null, warnings: ProfileIdentityWarning[]): ProfileIdentitySignal[] {
  if (raw === null) return [];
  const outer = parseJsonObject<KeychainOuter>(raw);
  const account = outer && typeof outer.account === 'string' ? outer.account : undefined;
  const body = outer && typeof outer.value === 'string' ? outer.value : raw;
  const parsed = parseJsonObject<ClaudeCredentials>(body);
  if (!parsed) {
    warnings.push(warning('parse-error', 'credentials.json'));
    return [];
  }
  const out: ProfileIdentitySignal[] = [];
  if (account !== undefined) out.push(fingerprintSignal('account', 'credentials.json', 'high', account));
  const tier = allowlistedValue(parsed.claudeAiOauth?.subscriptionType, SUBSCRIPTION_VALUES);
  if (tier) out.push(signal('subscription-tier', 'credentials.json', 'medium', { value: tier }));
  return out;
}

interface ProviderAuth {
  type?: 'oauth' | 'api';
  accountId?: string;
}

type OpenCodeAuth = Record<string, unknown>;

function opencodeSignals(raw: string | null, warnings: ProfileIdentityWarning[]): ProfileIdentitySignal[] {
  if (raw === null) return [];
  const parsed = parseJsonObject<OpenCodeAuth>(raw);
  if (!parsed) {
    warnings.push(warning('parse-error', 'opencode-auth.json'));
    return [];
  }
  return Object.entries(parsed).flatMap(([provider, auth]) => providerSignals(provider, auth, warnings));
}

function providerSignals(
  provider: string,
  auth: ProviderAuth | unknown,
  warnings: ProfileIdentityWarning[]
): ProfileIdentitySignal[] {
  const source = 'opencode-auth.json';
  const out = [signal('provider', source, 'medium', safeProviderValue(provider))];
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) {
    warnings.push(warning('parse-error', source));
    return out;
  }
  const typed = auth as ProviderAuth;
  if (typed.type === 'oauth' && typeof typed.accountId === 'string') {
    out.push(fingerprintSignal('account', source, 'high', typed.accountId));
  } else if (typed.type === 'api') {
    out.push(signal('api-key-mode', source, 'medium'));
  }
  return out;
}

function gooseSignals(sources: IdentitySourceInput[], warnings: ProfileIdentityWarning[]): ProfileIdentitySignal[] {
  const out: ProfileIdentitySignal[] = [];
  for (const src of sources) {
    if (src.value === null || !src.saveAs.startsWith('goose-')) continue;
    out.push(...gooseSourceSignals(src.saveAs, src.value, warnings));
  }
  return out;
}

function gooseSourceSignals(saveAs: string, raw: string, warnings: ProfileIdentityWarning[]): ProfileIdentitySignal[] {
  const parsed = parseGooseYaml(raw);
  if (!parsed) {
    warnings.push(warning('parse-error', saveAs));
    return [];
  }
  const keys = Object.keys(parsed).filter((key) => PROVIDER_KEY_RE.test(key)).sort();
  const out = keys.length > 0 ? [fingerprintSignal('provider', saveAs, 'medium', keys.join(','))] : [];
  const provider = parsed.GOOSE_PROVIDER__TYPE ?? parsed.GOOSE_PROVIDER;
  if (typeof provider === 'string') out.push(signal('routing', saveAs, 'medium', safeProviderValue(provider)));
  return out;
}

function parseGooseYaml(raw: string): Record<string, string> | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, { maxAliasCount: 100, logLevel: 'error' });
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && SAFE_VALUE_RE.test(key)) out[key] = value;
  }
  return out;
}

export function normalizeProfileIdentity(value: unknown): ProfileIdentitySummary | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<ProfileIdentitySummary>;
  if (raw.schemaVersion !== IDENTITY_SCHEMA_VERSION) return undefined;
  const capturedAt = normalizeIsoString(raw.capturedAt);
  if (!capturedAt) return undefined;
  const status = normalizeStatus(raw.status);
  const completeness = normalizeCompleteness(raw.completeness);
  const signals = Array.isArray(raw.signals) ? raw.signals.map(normalizeSignal).filter(isSignal) : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.map(normalizeWarning).filter(isWarning) : [];
  return { schemaVersion: IDENTITY_SCHEMA_VERSION, status, capturedAt, completeness, signals, ...(warnings.length ? { warnings } : {}) };
}

function normalizeStatus(value: unknown): ProfileIdentityStatus {
  return value === 'available' || value === 'unsupported' ? value : 'unavailable';
}

function normalizeCompleteness(value: unknown): ProfileIdentityCompleteness {
  if (value === 'complete' || value === 'partial' || value === 'unknown') return value;
  return 'unknown';
}

function normalizeSignal(value: unknown): ProfileIdentitySignal | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<ProfileIdentitySignal>;
  if (!isSignalKind(raw.kind) || !isConfidence(raw.confidence) || typeof raw.source !== 'string') return undefined;
  const base = signal(raw.kind, raw.source, raw.confidence);
  if (raw.kind === 'api-key-mode') return base;
  const fingerprint = typeof raw.fingerprint === 'string' && FINGERPRINT_RE.test(raw.fingerprint) ? raw.fingerprint : undefined;
  const safeValue = normalizeSignalValue(raw.kind, raw.value);
  if (!fingerprint && !safeValue) return undefined;
  return fingerprint ? { ...base, fingerprint } : { ...base, ...(safeValue ? { value: safeValue } : {}) };
}

function normalizeSignalValue(kind: ProfileIdentitySignalKind, value: unknown): string | undefined {
  if (typeof value !== 'string' || EMAILISH_RE.test(value) || redactMessage(value) !== value) return undefined;
  if (kind === 'subscription-tier') return allowlistedValue(value, SUBSCRIPTION_VALUES);
  if (kind === 'auth-mode') return allowlistedValue(value, AUTH_MODE_VALUES);
  if (kind === 'provider' || kind === 'routing') return allowlistedValue(value, PROVIDER_VALUES);
  return undefined;
}

function normalizeWarning(value: unknown): ProfileIdentityWarning | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Partial<ProfileIdentityWarning>;
  if (!isWarningCode(raw.code)) return undefined;
  return warning(raw.code, typeof raw.source === 'string' ? raw.source : undefined);
}

function isSignal(value: ProfileIdentitySignal | undefined): value is ProfileIdentitySignal {
  return value !== undefined;
}

function isWarning(value: ProfileIdentityWarning | undefined): value is ProfileIdentityWarning {
  return value !== undefined;
}

function isSignalKind(value: unknown): value is ProfileIdentitySignalKind {
  return (
    value === 'account' ||
    value === 'email' ||
    value === 'subscription-tier' ||
    value === 'auth-mode' ||
    value === 'provider' ||
    value === 'routing' ||
    value === 'api-key-mode'
  );
}

function isConfidence(value: unknown): value is ProfileIdentityConfidence {
  return value === 'high' || value === 'medium' || value === 'low';
}

function isWarningCode(value: unknown): value is ProfileIdentityWarningCode {
  return (
    value === 'missing-source' ||
    value === 'carried-forward' ||
    value === 'parse-error' ||
    value === 'no-identity' ||
    value === 'unsupported' ||
    value === 'lock-free-recapture'
  );
}

export function formatProfileIdentity(identity: ProfileIdentitySummary | undefined): string {
  if (!identity) return 'identity: unavailable';
  const parts = identity.signals.map(formatSignal);
  const body = parts.length > 0 ? parts.join(', ') : identity.status;
  return `identity: ${body} (${identity.completeness}, ${identity.capturedAt})`;
}

function formatSignal(signal: ProfileIdentitySignal): string {
  const value = signal.fingerprint ?? signal.value ?? signal.kind;
  return `${signal.kind}:${value}`;
}

export function identityCapabilitiesForCli(cliId: string): ProfileIdentityCapability {
  switch (cliId) {
    case 'codex':
      return cap('available', [{ kind: 'account', source: 'auth.json', safety: 'masked' }, { kind: 'api-key-mode', source: 'auth.json', safety: 'mode-only' }]);
    case 'gemini':
      return cap('available', [{ kind: 'email', source: 'google_accounts.json', safety: 'masked' }]);
    case 'claude':
      return cap('available', [{ kind: 'account', source: 'credentials.json', safety: 'masked' }, { kind: 'subscription-tier', source: 'credentials.json', safety: 'allowlisted' }]);
    case 'opencode':
      return cap('available', [{ kind: 'provider', source: 'opencode-auth.json', safety: 'allowlisted' }, { kind: 'account', source: 'opencode-auth.json', safety: 'masked' }]);
    case 'goose':
      return cap('available', [{ kind: 'provider', source: 'goose-*.yaml', safety: 'masked' }, { kind: 'routing', source: 'goose-config.yaml', safety: 'allowlisted' }]);
    default:
      return cap('unsupported', []);
  }
}

function cap(status: ProfileIdentityStatus, signals: ProfileIdentityCapability['signals']): ProfileIdentityCapability {
  return {
    status,
    signals,
    caveats: ['Computed only at capture/recapture time; read-only commands do not parse credential files.']
  };
}
