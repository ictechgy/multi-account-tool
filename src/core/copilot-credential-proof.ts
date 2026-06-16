/**
 * Pure redacted Copilot credential-store proof report validator.
 *
 * This module validates metadata-only report shape and consistency. It is not
 * platform proof, not product support, and intentionally performs no filesystem,
 * process, shell, or credential-store access.
 */

export type CopilotCredentialProofEvidenceKind = 'upstream-documentation' | 'human-reviewed-local-probe';
export type CopilotCredentialProofPlatform =
  | 'darwin-keychain'
  | 'linux-secret-service'
  | 'windows-credential-manager';
export type CopilotCredentialProofSelectorStatus = 'verified' | 'missing' | 'ambiguous' | 'unverified';
export type CopilotCredentialProofEntryCardinality =
  | 'one-per-account'
  | 'aggregate'
  | 'multiple-ambiguous'
  | 'missing'
  | 'unverified';
export type CopilotCredentialProofAppStateCrossCheck = 'matches-redacted-binding' | 'not-run' | 'failed';
export type CopilotCredentialProofAmbientTokenPolicy =
  | 'not-yet-covered'
  | 'policy-documented-implementation-pending'
  | 'controlled-by-implementation';
export type CopilotCredentialProofClaimedConclusion = 'pass' | 'fail' | 'blocked';
export type CopilotCredentialProofMetadataConclusion = 'metadata-pass' | 'metadata-fail' | 'metadata-blocked';
export type CopilotCredentialProofLevel = 'metadata-report-only';
export type CopilotCredentialProofProductSupport = 'blocked';
export type CopilotWindowsCredentialProofStatus = CopilotCredentialProofSelectorStatus;
export type CopilotWindowsCredentialType = 'generic';

export type CopilotCredentialProofIssueCode =
  | 'invalid-json'
  | 'invalid-root'
  | 'invalid-schema-version'
  | 'invalid-subject'
  | 'invalid-evidence-kind'
  | 'invalid-observed-at'
  | 'invalid-notes'
  | 'invalid-platforms'
  | 'duplicate-platform'
  | 'invalid-platform'
  | 'invalid-service-name'
  | 'invalid-service-name-source'
  | 'invalid-selector'
  | 'invalid-selector-status'
  | 'invalid-selector-field'
  | 'invalid-selector-value-policy'
  | 'invalid-cardinality'
  | 'invalid-secret-observation'
  | 'invalid-raw-output-flag'
  | 'invalid-app-state-cross-check'
  | 'invalid-ambient-token-policy'
  | 'invalid-windows-binding-proof'
  | 'invalid-windows-binding-status'
  | 'invalid-windows-binding-value-policy'
  | 'invalid-windows-credential-type'
  | 'invalid-conclusion'
  | 'inconsistent-pass'
  | 'inconsistent-fail'
  | 'inconsistent-blocked'
  | 'unknown-key'
  | 'forbidden-evidence-key'
  | 'token-shaped-value'
  | 'real-label-value';

export interface CopilotCredentialProofIssue {
  code: CopilotCredentialProofIssueCode;
  path: string;
  message: string;
}

export interface CopilotCredentialProofSelector {
  status: CopilotCredentialProofSelectorStatus;
  fieldName?: string;
  valuePolicy?: string;
}

export interface CopilotWindowsCredentialBindingProofPart {
  status: CopilotWindowsCredentialProofStatus;
  valuePolicy?: string;
}

export interface CopilotWindowsCredentialBindingProof {
  targetName: CopilotWindowsCredentialBindingProofPart;
  credentialType: CopilotWindowsCredentialType;
  accountUserNameGuard: CopilotWindowsCredentialBindingProofPart;
}

export interface CopilotCredentialProofPlatformReport {
  platform: CopilotCredentialProofPlatform;
  serviceName: string;
  serviceNameSource: string;
  perAccountSelector: CopilotCredentialProofSelector;
  entryCardinality: CopilotCredentialProofEntryCardinality;
  secretValuesObservedByMat: boolean;
  rawCredentialStoreOutputCommitted: boolean;
  appStateCrossCheck: CopilotCredentialProofAppStateCrossCheck;
  ambientTokenPolicy: CopilotCredentialProofAmbientTokenPolicy;
  windowsCredentialBindingProof?: CopilotWindowsCredentialBindingProof;
  conclusion: CopilotCredentialProofClaimedConclusion;
}

export interface CopilotCredentialProofReport {
  schemaVersion: 1;
  subject: 'github-copilot-cli';
  evidenceKind: CopilotCredentialProofEvidenceKind;
  observedAt: string;
  platforms: CopilotCredentialProofPlatformReport[];
  notes?: string[];
}

export interface CopilotCredentialProofPlatformValidation {
  platform: CopilotCredentialProofPlatform | 'unknown';
  claimedConclusion: CopilotCredentialProofClaimedConclusion | 'invalid';
  metadataConclusion: CopilotCredentialProofMetadataConclusion;
  issues: CopilotCredentialProofIssue[];
}

export interface CopilotCredentialProofValidationResult {
  ok: boolean;
  structurallyValid: boolean;
  proofLevel: CopilotCredentialProofLevel;
  productSupport: CopilotCredentialProofProductSupport;
  issues: CopilotCredentialProofIssue[];
  platforms: CopilotCredentialProofPlatformValidation[];
}

type JsonObject = Record<string, unknown>;

type UnsafeEvidenceKind = 'forbidden-key' | 'token-shaped-value' | 'real-label-value';

interface UnsafeEvidenceFinding {
  kind: UnsafeEvidenceKind;
  path: string;
}

const PROOF_LEVEL: CopilotCredentialProofLevel = 'metadata-report-only';
const PRODUCT_SUPPORT: CopilotCredentialProofProductSupport = 'blocked';
const SUBJECT = 'github-copilot-cli';
const SERVICE_NAME = 'copilot-cli';

const EVIDENCE_KINDS = new Set<CopilotCredentialProofEvidenceKind>([
  'upstream-documentation',
  'human-reviewed-local-probe'
]);
const PLATFORMS = new Set<CopilotCredentialProofPlatform>([
  'darwin-keychain',
  'linux-secret-service',
  'windows-credential-manager'
]);
const SELECTOR_STATUSES = new Set<CopilotCredentialProofSelectorStatus>([
  'verified',
  'missing',
  'ambiguous',
  'unverified'
]);
const CARDINALITIES = new Set<CopilotCredentialProofEntryCardinality>([
  'one-per-account',
  'aggregate',
  'multiple-ambiguous',
  'missing',
  'unverified'
]);
const APP_STATE_CROSS_CHECKS = new Set<CopilotCredentialProofAppStateCrossCheck>([
  'matches-redacted-binding',
  'not-run',
  'failed'
]);
const AMBIENT_POLICIES = new Set<CopilotCredentialProofAmbientTokenPolicy>([
  'not-yet-covered',
  'policy-documented-implementation-pending',
  'controlled-by-implementation'
]);
const CLAIMED_CONCLUSIONS = new Set<CopilotCredentialProofClaimedConclusion>(['pass', 'fail', 'blocked']);
const ALLOWED_SELECTOR_FIELDS = new Set(['acct', 'account', 'redactedSelectorField']);
const SERVICE_ONLY_SELECTOR_FIELDS = new Set(['service', 'serviceName', 'svc', 'namespace', 'serviceNamespace']);
const ALLOWED_VALUE_POLICIES = new Set(['not-committed', 'synthetic-only']);
const ROOT_KEYS = new Set(['schemaVersion', 'subject', 'evidenceKind', 'observedAt', 'platforms', 'notes']);
const PLATFORM_REPORT_KEYS = new Set([
  'platform',
  'serviceName',
  'serviceNameSource',
  'perAccountSelector',
  'entryCardinality',
  'secretValuesObservedByMat',
  'rawCredentialStoreOutputCommitted',
  'appStateCrossCheck',
  'ambientTokenPolicy',
  'windowsCredentialBindingProof',
  'conclusion'
]);
const SELECTOR_KEYS = new Set(['status', 'fieldName', 'valuePolicy']);
const WINDOWS_BINDING_PROOF_KEYS = new Set(['targetName', 'credentialType', 'accountUserNameGuard']);
const WINDOWS_BINDING_PROOF_PART_KEYS = new Set(['status', 'valuePolicy']);
const SAFE_METADATA_NORMALIZED_KEYS = new Set(
  [...ROOT_KEYS, ...PLATFORM_REPORT_KEYS, ...SELECTOR_KEYS].map((key) => normalizeKey(key))
);
const FORBIDDEN_NORMALIZED_KEYS = new Set([
  'securityoutput',
  'secrettooloutput',
  'rawoutput',
  'rawcredentialstoreoutput',
  'credentialblob',
  'token',
  'accesstoken',
  'refreshtoken',
  'oauthtoken',
  'githubtoken',
  'tokenhash',
  'secret',
  'password',
  'hash',
  'fingerprint',
  'digest',
  'sha256',
  'sha256digest',
  'login',
  'displaylogin',
  'organization',
  'org',
  'accountid',
  'stableaccountid',
  'userid',
  'username',
  'accountlabel',
  'label'
]);

const TOKEN_SHAPE_PATTERNS = [
  new RegExp('\\bgh[pousr]' + '_[A-Za-z0-9_]{10,}\\b'),
  new RegExp('\\bgithub' + '_pat' + '_[A-Za-z0-9_]{10,}\\b'),
  new RegExp('\\bsk' + '-[A-Za-z0-9]{12,}\\b'),
  new RegExp('\\bxox[baprs]' + '-[A-Za-z0-9-]{8,}\\b'),
  new RegExp('\\bey' + 'J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b'),
  /\b[A-Fa-f0-9]{64,}\b/
] as const;
const EMAIL_LIKE_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function issue(code: CopilotCredentialProofIssueCode, path: string, message: string): CopilotCredentialProofIssue {
  return { code, path, message };
}

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isNonEmptyEvidenceValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function isForbiddenEvidenceKey(key: string): boolean {
  const normalized = normalizeKey(key);
  if (SAFE_METADATA_NORMALIZED_KEYS.has(normalized)) return false;
  return (
    FORBIDDEN_NORMALIZED_KEYS.has(normalized) ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('hash') ||
    normalized.includes('fingerprint') ||
    normalized.includes('digest') ||
    normalized.includes('sha256') ||
    (normalized.includes('raw') && normalized.includes('output')) ||
    (normalized.includes('credential') && normalized.includes('blob'))
  );
}

function safePathSegment(key: string): string {
  if (tokenShapePresent(key) || realLabelPresent(key)) return '<redacted-key>';
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) return key;
  return '<redacted-key>';
}

function childPathForKey(path: string, key: string): string {
  return `${path}.${safePathSegment(key)}`;
}

function tokenShapePresent(value: string): boolean {
  return TOKEN_SHAPE_PATTERNS.some((pattern) => pattern.test(value));
}

function realLabelPresent(value: string): boolean {
  const matches = value.match(EMAIL_LIKE_RE) ?? [];
  return matches.some((match) => !match.toLowerCase().endsWith('@fixture.example'));
}

export function collectCopilotCredentialProofUnsafeEvidence(
  value: unknown,
  path = '$'
): UnsafeEvidenceFinding[] {
  const findings: UnsafeEvidenceFinding[] = [];

  if (typeof value === 'string') {
    if (tokenShapePresent(value)) findings.push({ kind: 'token-shaped-value', path });
    if (realLabelPresent(value)) findings.push({ kind: 'real-label-value', path });
    return findings;
  }

  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      findings.push(...collectCopilotCredentialProofUnsafeEvidence(entry, `${path}[${index}]`));
    });
    return findings;
  }

  if (!isPlainObject(value)) return findings;

  for (const [key, child] of Object.entries(value)) {
    const childPath = childPathForKey(path, key);
    if (tokenShapePresent(key)) findings.push({ kind: 'token-shaped-value', path: childPath });
    if (realLabelPresent(key)) findings.push({ kind: 'real-label-value', path: childPath });
    if (isForbiddenEvidenceKey(key) && isNonEmptyEvidenceValue(child)) {
      findings.push({ kind: 'forbidden-key', path: childPath });
    }
    findings.push(...collectCopilotCredentialProofUnsafeEvidence(child, childPath));
  }

  return findings;
}

function unsafeEvidenceIssue(finding: UnsafeEvidenceFinding): CopilotCredentialProofIssue {
  if (finding.kind === 'forbidden-key') {
    return issue('forbidden-evidence-key', finding.path, 'Forbidden credential-store evidence field is present; key path only is reported.');
  }
  if (finding.kind === 'real-label-value') {
    return issue('real-label-value', finding.path, 'Real-looking account label is present; key path only is reported.');
  }
  return issue('token-shaped-value', finding.path, 'Token-shaped value is present; key path only is reported.');
}

function validateAllowedKeys(
  value: JsonObject,
  allowed: ReadonlySet<string>,
  path: string,
  issues: CopilotCredentialProofIssue[]
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push(issue('unknown-key', childPathForKey(path, key), 'Unexpected field in Copilot proof report.'));
    }
  }
}

function validateObservedAt(value: unknown, issues: CopilotCredentialProofIssue[]): void {
  const observedAt = nonEmptyString(value);
  if (!observedAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(observedAt)) {
    issues.push(issue('invalid-observed-at', '$.observedAt', 'observedAt must be a UTC ISO-8601 timestamp.'));
    return;
  }
  const date = new Date(observedAt);
  const canonical = observedAt.includes('.') ? observedAt : observedAt.replace(/Z$/, '.000Z');
  if (Number.isNaN(date.getTime()) || date.toISOString() !== canonical) {
    issues.push(issue('invalid-observed-at', '$.observedAt', 'observedAt must be a parseable UTC ISO-8601 timestamp.'));
  }
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  path: string,
  code: CopilotCredentialProofIssueCode,
  issues: CopilotCredentialProofIssue[]
): T | undefined {
  if (typeof value === 'string' && allowed.has(value as T)) return value as T;
  issues.push(issue(code, path, 'Invalid Copilot proof report enum value.'));
  return undefined;
}

function validateRequiredString(
  value: unknown,
  expected: string | null,
  path: string,
  code: CopilotCredentialProofIssueCode,
  message: string,
  issues: CopilotCredentialProofIssue[]
): string | undefined {
  const text = nonEmptyString(value);
  if (!text || (expected !== null && text !== expected)) {
    issues.push(issue(code, path, message));
    return undefined;
  }
  return text;
}

function validateSelector(
  raw: unknown,
  path: string,
  claimedConclusion: CopilotCredentialProofClaimedConclusion | undefined,
  issues: CopilotCredentialProofIssue[]
): CopilotCredentialProofSelector | undefined {
  if (!isPlainObject(raw)) {
    issues.push(issue('invalid-selector', path, 'perAccountSelector must be an object.'));
    return undefined;
  }

  validateAllowedKeys(raw, SELECTOR_KEYS, path, issues);

  const status = enumValue(raw.status, SELECTOR_STATUSES, `${path}.status`, 'invalid-selector-status', issues);
  const fieldName = nonEmptyString(raw.fieldName);
  const valuePolicy = nonEmptyString(raw.valuePolicy);

  if (fieldName && SERVICE_ONLY_SELECTOR_FIELDS.has(fieldName)) {
    issues.push(issue('invalid-selector-field', `${path}.fieldName`, 'Selector field cannot be service-only.'));
  }
  if (fieldName && !ALLOWED_SELECTOR_FIELDS.has(fieldName)) {
    issues.push(issue('invalid-selector-field', `${path}.fieldName`, 'Selector field is not an approved redacted selector field.'));
  }
  if (valuePolicy && !ALLOWED_VALUE_POLICIES.has(valuePolicy)) {
    issues.push(issue('invalid-selector-value-policy', `${path}.valuePolicy`, 'Selector value policy is not allowed in this metadata gate.'));
  }

  if (claimedConclusion === 'pass') {
    if (!fieldName) {
      issues.push(issue('invalid-selector-field', `${path}.fieldName`, 'Pass claims require a selector field.'));
    }
    if (!valuePolicy) {
      issues.push(issue('invalid-selector-value-policy', `${path}.valuePolicy`, 'Pass claims require a selector value policy.'));
    }
  }

  if (!status) return undefined;
  return {
    status,
    ...(fieldName ? { fieldName } : {}),
    ...(valuePolicy ? { valuePolicy } : {})
  };
}

function validateWindowsBindingProofPart(
  raw: unknown,
  path: string,
  passClaimed: boolean,
  issues: CopilotCredentialProofIssue[]
): CopilotWindowsCredentialBindingProofPart | undefined {
  if (!isPlainObject(raw)) {
    issues.push(issue('invalid-windows-binding-proof', path, 'Windows credential binding proof parts must be value-free objects.'));
    return undefined;
  }

  validateAllowedKeys(raw, WINDOWS_BINDING_PROOF_PART_KEYS, path, issues);

  const status = enumValue(
    raw.status,
    SELECTOR_STATUSES,
    `${path}.status`,
    'invalid-windows-binding-status',
    issues
  );
  const valuePolicy = nonEmptyString(raw.valuePolicy);
  if (valuePolicy && !ALLOWED_VALUE_POLICIES.has(valuePolicy)) {
    issues.push(
      issue(
        'invalid-windows-binding-value-policy',
        `${path}.valuePolicy`,
        'Windows credential binding value policy is not allowed in this metadata gate.'
      )
    );
  }
  if (passClaimed && !valuePolicy) {
    issues.push(
      issue(
        'invalid-windows-binding-value-policy',
        `${path}.valuePolicy`,
        'Windows pass claims require a value-free target/account value policy.'
      )
    );
  }

  if (!status) return undefined;
  return {
    status,
    ...(valuePolicy ? { valuePolicy } : {})
  };
}

function validateWindowsCredentialBindingProof(
  raw: unknown,
  path: string,
  platform: CopilotCredentialProofPlatform | undefined,
  claimedConclusion: CopilotCredentialProofClaimedConclusion | undefined,
  issues: CopilotCredentialProofIssue[]
): CopilotWindowsCredentialBindingProof | undefined {
  const windowsPassClaimed = platform === 'windows-credential-manager' && claimedConclusion === 'pass';
  if (raw === undefined) {
    if (windowsPassClaimed) {
      issues.push(
        issue(
          'invalid-windows-binding-proof',
          path,
          'Windows pass claims require value-free Windows Credential Manager binding proof metadata.'
        )
      );
    }
    return undefined;
  }

  if (platform !== undefined && platform !== 'windows-credential-manager') {
    issues.push(
      issue(
        'invalid-windows-binding-proof',
        path,
        'Windows Credential Manager binding proof metadata is allowed only on windows-credential-manager reports.'
      )
    );
  }

  if (!isPlainObject(raw)) {
    issues.push(issue('invalid-windows-binding-proof', path, 'windowsCredentialBindingProof must be a value-free object.'));
    return undefined;
  }

  validateAllowedKeys(raw, WINDOWS_BINDING_PROOF_KEYS, path, issues);

  const targetName = validateWindowsBindingProofPart(
    raw.targetName,
    `${path}.targetName`,
    windowsPassClaimed,
    issues
  );
  const accountUserNameGuard = validateWindowsBindingProofPart(
    raw.accountUserNameGuard,
    `${path}.accountUserNameGuard`,
    windowsPassClaimed,
    issues
  );
  const credentialType = raw.credentialType === 'generic' ? 'generic' : undefined;
  if (!credentialType) {
    issues.push(
      issue(
        'invalid-windows-credential-type',
        `${path}.credentialType`,
        'Windows credential binding proof requires credentialType generic.'
      )
    );
  }

  if (!targetName || !accountUserNameGuard || !credentialType) return undefined;
  return {
    targetName,
    credentialType,
    accountUserNameGuard
  };
}

function windowsBindingProofCriteriaMet(proof: CopilotWindowsCredentialBindingProof | undefined): boolean {
  return (
    proof !== undefined &&
    proof.targetName.status === 'verified' &&
    Boolean(proof.targetName.valuePolicy) &&
    proof.credentialType === 'generic' &&
    proof.accountUserNameGuard.status === 'verified' &&
    Boolean(proof.accountUserNameGuard.valuePolicy)
  );
}

function passCriteriaMet(platform: CopilotCredentialProofPlatformReport): boolean {
  const baseCriteriaMet = (
    platform.conclusion === 'pass' &&
    platform.serviceName === SERVICE_NAME &&
    platform.serviceNameSource.trim().length > 0 &&
    platform.perAccountSelector.status === 'verified' &&
    Boolean(platform.perAccountSelector.fieldName) &&
    Boolean(platform.perAccountSelector.valuePolicy) &&
    platform.entryCardinality === 'one-per-account' &&
    platform.secretValuesObservedByMat === false &&
    platform.rawCredentialStoreOutputCommitted === false &&
    platform.appStateCrossCheck === 'matches-redacted-binding' &&
    platform.ambientTokenPolicy !== 'not-yet-covered'
  );
  if (!baseCriteriaMet) return false;
  if (platform.platform === 'windows-credential-manager') {
    return windowsBindingProofCriteriaMet(platform.windowsCredentialBindingProof);
  }
  return platform.windowsCredentialBindingProof === undefined;
}

function validatePassConsistency(platform: CopilotCredentialProofPlatformReport, issues: CopilotCredentialProofIssue[], path: string): void {
  if (platform.serviceNameSource.trim().length === 0) {
    issues.push(issue('invalid-service-name-source', `${path}.serviceNameSource`, 'Pass claims require a service name source.'));
  }
  if (platform.perAccountSelector.status !== 'verified') {
    issues.push(issue('inconsistent-pass', `${path}.perAccountSelector.status`, 'Pass claims require a verified selector.'));
  }
  if (platform.entryCardinality !== 'one-per-account') {
    issues.push(issue('inconsistent-pass', `${path}.entryCardinality`, 'Pass claims require one-per-account cardinality.'));
  }
  if (platform.appStateCrossCheck !== 'matches-redacted-binding') {
    issues.push(issue('inconsistent-pass', `${path}.appStateCrossCheck`, 'Pass claims require app-state cross-check.'));
  }
  if (platform.ambientTokenPolicy === 'not-yet-covered') {
    issues.push(issue('inconsistent-pass', `${path}.ambientTokenPolicy`, 'Pass claims require ambient-token policy coverage.'));
  }
  if (platform.platform === 'windows-credential-manager') {
    const proof = platform.windowsCredentialBindingProof;
    if (!proof) {
      issues.push(
        issue(
          'invalid-windows-binding-proof',
          `${path}.windowsCredentialBindingProof`,
          'Windows pass claims require value-free Windows Credential Manager binding proof metadata.'
        )
      );
      return;
    }
    if (proof.targetName.status !== 'verified') {
      issues.push(
        issue(
          'inconsistent-pass',
          `${path}.windowsCredentialBindingProof.targetName.status`,
          'Windows pass claims require verified targetName metadata.'
        )
      );
    }
    if (!proof.targetName.valuePolicy) {
      issues.push(
        issue(
          'invalid-windows-binding-value-policy',
          `${path}.windowsCredentialBindingProof.targetName.valuePolicy`,
          'Windows pass claims require targetName value policy.'
        )
      );
    }
    if (proof.credentialType !== 'generic') {
      issues.push(
        issue(
          'invalid-windows-credential-type',
          `${path}.windowsCredentialBindingProof.credentialType`,
          'Windows pass claims require generic credential type.'
        )
      );
    }
    if (proof.accountUserNameGuard.status !== 'verified') {
      issues.push(
        issue(
          'inconsistent-pass',
          `${path}.windowsCredentialBindingProof.accountUserNameGuard.status`,
          'Windows pass claims require verified account/UserName guard metadata.'
        )
      );
    }
    if (!proof.accountUserNameGuard.valuePolicy) {
      issues.push(
        issue(
          'invalid-windows-binding-value-policy',
          `${path}.windowsCredentialBindingProof.accountUserNameGuard.valuePolicy`,
          'Windows pass claims require account/UserName guard value policy.'
        )
      );
    }
  }
}

function validateFailBlockedConsistency(
  platform: CopilotCredentialProofPlatformReport,
  issues: CopilotCredentialProofIssue[],
  path: string
): void {
  const passLike = {
    ...platform,
    conclusion: 'pass' as const
  };
  if (passCriteriaMet(passLike)) {
    issues.push(
      issue(
        platform.conclusion === 'fail' ? 'inconsistent-fail' : 'inconsistent-blocked',
        `${path}.conclusion`,
        'Fail/blocked reports must not contain all metadata-pass criteria.'
      )
    );
  }
}

function metadataConclusionFor(
  claimedConclusion: CopilotCredentialProofClaimedConclusion | undefined,
  platform: CopilotCredentialProofPlatform | undefined,
  issues: CopilotCredentialProofIssue[],
  normalized?: CopilotCredentialProofPlatformReport
): CopilotCredentialProofMetadataConclusion {
  if (issues.length > 0) return 'metadata-fail';
  if (claimedConclusion === 'blocked') return 'metadata-blocked';
  if (claimedConclusion === 'pass' && normalized && passCriteriaMet(normalized)) return 'metadata-pass';
  return 'metadata-fail';
}

function validatePlatform(raw: unknown, index: number): CopilotCredentialProofPlatformValidation {
  const path = `$.platforms[${index}]`;
  const issues: CopilotCredentialProofIssue[] = [];
  if (!isPlainObject(raw)) {
    return {
      platform: 'unknown',
      claimedConclusion: 'invalid',
      metadataConclusion: 'metadata-fail',
      issues: [issue('invalid-platforms', path, 'Platform report must be an object.')]
    };
  }

  validateAllowedKeys(raw, PLATFORM_REPORT_KEYS, path, issues);

  const platform = enumValue(raw.platform, PLATFORMS, `${path}.platform`, 'invalid-platform', issues);
  validateRequiredString(raw.serviceName, SERVICE_NAME, `${path}.serviceName`, 'invalid-service-name', 'serviceName must be copilot-cli.', issues);
  const serviceNameSource = validateRequiredString(
    raw.serviceNameSource,
    null,
    `${path}.serviceNameSource`,
    'invalid-service-name-source',
    'serviceNameSource must be a non-empty string.',
    issues
  );
  const claimedConclusion = enumValue(
    raw.conclusion,
    CLAIMED_CONCLUSIONS,
    `${path}.conclusion`,
    'invalid-conclusion',
    issues
  );
  const selector = validateSelector(raw.perAccountSelector, `${path}.perAccountSelector`, claimedConclusion, issues);
  const entryCardinality = enumValue(
    raw.entryCardinality,
    CARDINALITIES,
    `${path}.entryCardinality`,
    'invalid-cardinality',
    issues
  );
  if (raw.secretValuesObservedByMat !== false) {
    issues.push(issue('invalid-secret-observation', `${path}.secretValuesObservedByMat`, 'Secret observation must be false.'));
  }
  if (raw.rawCredentialStoreOutputCommitted !== false) {
    issues.push(
      issue('invalid-raw-output-flag', `${path}.rawCredentialStoreOutputCommitted`, 'Raw credential-store output committed must be false.')
    );
  }
  const appStateCrossCheck = enumValue(
    raw.appStateCrossCheck,
    APP_STATE_CROSS_CHECKS,
    `${path}.appStateCrossCheck`,
    'invalid-app-state-cross-check',
    issues
  );
  const ambientTokenPolicy = enumValue(
    raw.ambientTokenPolicy,
    AMBIENT_POLICIES,
    `${path}.ambientTokenPolicy`,
    'invalid-ambient-token-policy',
    issues
  );
  const windowsCredentialBindingProof = validateWindowsCredentialBindingProof(
    raw.windowsCredentialBindingProof,
    `${path}.windowsCredentialBindingProof`,
    platform,
    claimedConclusion,
    issues
  );

  let normalized: CopilotCredentialProofPlatformReport | undefined;
  if (
    platform &&
    serviceNameSource &&
    claimedConclusion &&
    selector &&
    entryCardinality &&
    appStateCrossCheck &&
    ambientTokenPolicy
  ) {
    normalized = {
      platform,
      serviceName: SERVICE_NAME,
      serviceNameSource,
      perAccountSelector: selector,
      entryCardinality,
      secretValuesObservedByMat: false,
      rawCredentialStoreOutputCommitted: false,
      appStateCrossCheck,
      ambientTokenPolicy,
      ...(windowsCredentialBindingProof ? { windowsCredentialBindingProof } : {}),
      conclusion: claimedConclusion
    };
    if (claimedConclusion === 'pass') {
      validatePassConsistency(normalized, issues, path);
    } else {
      validateFailBlockedConsistency(normalized, issues, path);
    }
  }

  return {
    platform: platform ?? 'unknown',
    claimedConclusion: claimedConclusion ?? 'invalid',
    metadataConclusion: metadataConclusionFor(claimedConclusion, platform, issues, normalized),
    issues
  };
}

function invalidResult(issues: CopilotCredentialProofIssue[]): CopilotCredentialProofValidationResult {
  return {
    ok: false,
    structurallyValid: false,
    proofLevel: PROOF_LEVEL,
    productSupport: PRODUCT_SUPPORT,
    issues,
    platforms: []
  };
}

export function validateCopilotCredentialProofReport(raw: string | unknown): CopilotCredentialProofValidationResult {
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return invalidResult([issue('invalid-json', '$', 'Copilot proof report is not valid JSON.')]);
    }
  } else {
    parsed = raw;
  }

  if (!isPlainObject(parsed)) {
    return invalidResult([issue('invalid-root', '$', 'Copilot proof report root must be an object.')]);
  }

  const unsafeEvidenceIssues = collectCopilotCredentialProofUnsafeEvidence(parsed).map(unsafeEvidenceIssue);
  const issues = unsafeEvidenceIssues.filter((entry) => !/^\$\.platforms\[\d+\](?:\.|$)/.test(entry.path));
  const unsafeIssuesByPlatform = new Map<number, CopilotCredentialProofIssue[]>();
  for (const unsafeIssue of unsafeEvidenceIssues) {
    const match = unsafeIssue.path.match(/^\$\.platforms\[(\d+)\](?:\.|$)/);
    if (!match) continue;
    const index = Number(match[1]);
    const existing = unsafeIssuesByPlatform.get(index) ?? [];
    existing.push(unsafeIssue);
    unsafeIssuesByPlatform.set(index, existing);
  }

  validateAllowedKeys(parsed, ROOT_KEYS, '$', issues);

  if (parsed.schemaVersion !== 1) {
    issues.push(issue('invalid-schema-version', '$.schemaVersion', 'schemaVersion must be 1.'));
  }
  if (parsed.subject !== SUBJECT) {
    issues.push(issue('invalid-subject', '$.subject', 'subject must be github-copilot-cli.'));
  }
  enumValue(parsed.evidenceKind, EVIDENCE_KINDS, '$.evidenceKind', 'invalid-evidence-kind', issues);
  validateObservedAt(parsed.observedAt, issues);
  if (
    parsed.notes !== undefined &&
    (!Array.isArray(parsed.notes) || parsed.notes.some((entry) => typeof entry !== 'string'))
  ) {
    issues.push(issue('invalid-notes', '$.notes', 'notes must be an array of strings when present.'));
  }

  const platformsRaw = parsed.platforms;
  if (!Array.isArray(platformsRaw) || platformsRaw.length === 0) {
    issues.push(issue('invalid-platforms', '$.platforms', 'platforms must be a non-empty array.'));
    return {
      ok: false,
      structurallyValid: false,
      proofLevel: PROOF_LEVEL,
      productSupport: PRODUCT_SUPPORT,
      issues,
      platforms: []
    };
  }

  const platforms = platformsRaw.map((entry, index) => {
    const validation = validatePlatform(entry, index);
    const unsafeIssues = unsafeIssuesByPlatform.get(index) ?? [];
    if (unsafeIssues.length === 0) return validation;
    return {
      ...validation,
      metadataConclusion: 'metadata-fail' as const,
      issues: [...unsafeIssues, ...validation.issues]
    };
  });
  const seenPlatforms = new Set<string>();
  for (const platform of platforms) {
    if (platform.platform === 'unknown') continue;
    if (seenPlatforms.has(platform.platform)) {
      issues.push(issue('duplicate-platform', '$.platforms', 'Duplicate platform entries are not allowed.'));
    }
    seenPlatforms.add(platform.platform);
  }

  const allIssues = [...issues, ...platforms.flatMap((platform) => platform.issues)];
  const ok = allIssues.length === 0;
  return {
    ok,
    structurallyValid: ok,
    proofLevel: PROOF_LEVEL,
    productSupport: PRODUCT_SUPPORT,
    issues,
    platforms
  };
}
