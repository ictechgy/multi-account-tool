/**
 * Pure security-review gate for future Copilot executable probe proposals.
 *
 * This module does not add or run a probe, does not read credential stores,
 * and does not add Copilot product support. It only evaluates whether a
 * value-free proposal is eligible for a separate implementation review.
 */

import {
  collectCopilotCredentialProofUnsafeEvidence,
  type CopilotCredentialProofPlatform
} from './copilot-credential-proof.js';

export type CopilotExecutableProbeSecurityReviewStatus =
  | 'eligible-for-implementation-review'
  | 'blocked'
  | 'rejected'
  | 'deferred';

export type CopilotExecutableProbePlatform = CopilotCredentialProofPlatform;
export type CopilotExecutableProbeCollectionIntent = 'future-executable-local-probe' | 'unsupported-future-mode';
export type CopilotExecutableProbePermissionMode = 'minimal-explicit-allowlist' | 'broad-allow-all' | 'unspecified';
export type CopilotExecutableProbeToolClass =
  | 'copilot-cli-metadata-only'
  | 'platform-credential-store-metadata-only'
  | 'app-state-metadata-only'
  | 'ambient-env-metadata-only'
  | 'redaction-only';
export type CopilotExecutableProbeDeniedToolClass =
  | 'raw-credential-output'
  | 'secret-value-read'
  | 'shell-transcript-capture'
  | 'broad-permission-mode'
  | 'product-runtime-wiring'
  | 'source-schema-wiring';

export interface CopilotExecutableProbeSecurityReviewProposalV1 {
  schemaVersion: 1;
  subject: 'github-copilot-cli';
  reviewKind: 'executable-probe-security-review';
  targetPlatforms: CopilotExecutableProbePlatform[];
  collectionIntent: CopilotExecutableProbeCollectionIntent;
  implementationInThisChange: boolean;
  runnableProbeAdded: boolean;
  credentialStoreAccessedByMat: boolean;
  productSupportClaimed: boolean;
  platformProofClaimedComplete: boolean;
  separateAuthorizationRequired: boolean;
  localUserOptInRequired: boolean;
  secondReviewerRequired: boolean;
  commandPolicy: {
    permissionMode: CopilotExecutableProbePermissionMode;
    allowedToolClasses: CopilotExecutableProbeToolClass[];
    deniedToolClasses: CopilotExecutableProbeDeniedToolClass[];
  };
  environmentPolicy: {
    ambientTokenPolicy: 'must-control-or-block';
    isolatedConfigHomeRequired: boolean;
    plaintextFallbackPolicy: 'reject';
  };
  outputPolicy: {
    rawLocalOutputPolicy: 'discard-before-review';
    allowedMetadata: 'value-free-enums-only';
    forbidHashesAndFingerprints: boolean;
    forbidAccountLabels: boolean;
  };
  cleanupPolicy: {
    noMutationExpected: boolean;
    cleanupRequired: boolean;
    failureTaxonomyRequired: boolean;
  };
  reviewPolicy: {
    appStateCrossCheckRequired: boolean;
    switchScenarioRequired: boolean;
    docsEvidenceRefreshed: boolean;
    humanRedactionRequired: boolean;
  };
}

export type CopilotExecutableProbeSecurityReviewIssueCode =
  | 'invalid-proposal'
  | 'unknown-proposal-key'
  | 'invalid-target-platform'
  | 'duplicate-target-platform'
  | 'missing-review-precondition'
  | 'unsafe-evidence'
  | 'product-support-claim'
  | 'platform-proof-claim'
  | 'executable-probe-present'
  | 'credential-store-accessed-by-mat'
  | 'broad-permission-mode'
  | 'missing-tool-policy'
  | 'missing-denylist'
  | 'missing-environment-policy'
  | 'missing-output-policy'
  | 'missing-cleanup-policy'
  | 'stale-docs-evidence'
  | 'unsupported-collection-intent'
  | 'implementation-requested';

export interface CopilotExecutableProbeSecurityReviewIssue {
  code: CopilotExecutableProbeSecurityReviewIssueCode;
  path: string;
  message: string;
}

export interface CopilotExecutableProbeSecurityReviewResult {
  ok: boolean;
  status: CopilotExecutableProbeSecurityReviewStatus;
  productSupport: 'blocked';
  platformProof: 'not-proven';
  executableProbe: 'not-added';
  targetPlatforms: CopilotExecutableProbePlatform[];
  issues: CopilotExecutableProbeSecurityReviewIssue[];
}

type JsonObject = Record<string, unknown>;
type IssueBucket = 'rejected' | 'deferred' | 'blocked';

interface BucketedIssue extends CopilotExecutableProbeSecurityReviewIssue {
  bucket: IssueBucket;
}

const PRODUCT_SUPPORT = 'blocked' as const;
const PLATFORM_PROOF = 'not-proven' as const;
const EXECUTABLE_PROBE = 'not-added' as const;
const SUBJECT = 'github-copilot-cli';
const REVIEW_KIND = 'executable-probe-security-review';

const PLATFORMS = new Set<CopilotExecutableProbePlatform>([
  'darwin-keychain',
  'linux-secret-service',
  'windows-credential-manager'
]);
const COLLECTION_INTENTS = new Set<CopilotExecutableProbeCollectionIntent>([
  'future-executable-local-probe',
  'unsupported-future-mode'
]);
const PERMISSION_MODES = new Set<CopilotExecutableProbePermissionMode>([
  'minimal-explicit-allowlist',
  'broad-allow-all',
  'unspecified'
]);
const REQUIRED_ALLOWED_TOOL_CLASSES = new Set<CopilotExecutableProbeToolClass>([
  'copilot-cli-metadata-only',
  'platform-credential-store-metadata-only',
  'app-state-metadata-only',
  'ambient-env-metadata-only',
  'redaction-only'
]);
const REQUIRED_DENIED_TOOL_CLASSES = new Set<CopilotExecutableProbeDeniedToolClass>([
  'raw-credential-output',
  'secret-value-read',
  'shell-transcript-capture',
  'broad-permission-mode',
  'product-runtime-wiring',
  'source-schema-wiring'
]);

const ROOT_KEYS = new Set([
  'schemaVersion',
  'subject',
  'reviewKind',
  'targetPlatforms',
  'collectionIntent',
  'implementationInThisChange',
  'runnableProbeAdded',
  'credentialStoreAccessedByMat',
  'productSupportClaimed',
  'platformProofClaimedComplete',
  'separateAuthorizationRequired',
  'localUserOptInRequired',
  'secondReviewerRequired',
  'commandPolicy',
  'environmentPolicy',
  'outputPolicy',
  'cleanupPolicy',
  'reviewPolicy'
]);
const COMMAND_POLICY_KEYS = new Set(['permissionMode', 'allowedToolClasses', 'deniedToolClasses']);
const ENVIRONMENT_POLICY_KEYS = new Set(['ambientTokenPolicy', 'isolatedConfigHomeRequired', 'plaintextFallbackPolicy']);
const OUTPUT_POLICY_KEYS = new Set([
  'rawLocalOutputPolicy',
  'allowedMetadata',
  'forbidHashesAndFingerprints',
  'forbidAccountLabels'
]);
const CLEANUP_POLICY_KEYS = new Set(['noMutationExpected', 'cleanupRequired', 'failureTaxonomyRequired']);
const REVIEW_POLICY_KEYS = new Set([
  'appStateCrossCheckRequired',
  'switchScenarioRequired',
  'docsEvidenceRefreshed',
  'humanRedactionRequired'
]);

const PRODUCT_CLAIM_KEYS = new Set([
  'productsupport',
  'supportstatus',
  'builtin',
  'copilotbuiltin',
  'runtimewiring',
  'productwiring',
  'platformsupport'
]);
const PLATFORM_PROOF_CLAIM_KEYS = new Set([
  'prooflevel',
  'platformproof',
  'platformproofcomplete',
  'platformproofclaimedcomplete',
  'proofcomplete'
]);
const SAFE_UNSAFE_SCANNER_POLICY_PATHS = new Set([
  '$.outputPolicy.rawLocalOutputPolicy',
  '$.outputPolicy.forbidHashesAndFingerprints'
]);

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function childPath(path: string, key: string): string {
  return `${path}.${ROOT_KEYS.has(key) || /^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key) ? key : '<unknown-key>'}`;
}

function issue(
  bucket: IssueBucket,
  code: CopilotExecutableProbeSecurityReviewIssueCode,
  path: string,
  message: string
): BucketedIssue {
  return { bucket, code, path, message };
}

function collectUnknownKeyIssues(value: unknown, allowed: ReadonlySet<string>, path: string): BucketedIssue[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map(() => issue('rejected', 'unknown-proposal-key', `${path}.<unknown-key>`, 'Unexpected proposal field is present.'));
}

function collectUnsafeIssues(proposal: unknown): BucketedIssue[] {
  return collectCopilotCredentialProofUnsafeEvidence(proposal)
    .filter((finding) => !(finding.kind === 'forbidden-key' && SAFE_UNSAFE_SCANNER_POLICY_PATHS.has(finding.path)))
    .map((finding) =>
      issue('rejected', 'unsafe-evidence', finding.path, 'Unsafe credential evidence is present; key path only is reported.')
    );
}

function collectClaimIssues(value: unknown, path = '$'): BucketedIssue[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectClaimIssues(entry, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) return [];

  const issues: BucketedIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    const candidatePath = childPath(path, key);
    const present = child !== false && child !== null && child !== undefined && !(typeof child === 'string' && child.trim() === '');
    if (present && PRODUCT_CLAIM_KEYS.has(normalized)) {
      issues.push(issue('rejected', 'product-support-claim', candidatePath, 'Product support claims are not admissible.'));
    }
    if (present && PLATFORM_PROOF_CLAIM_KEYS.has(normalized)) {
      issues.push(issue('rejected', 'platform-proof-claim', candidatePath, 'Completed platform-proof claims are not admissible.'));
    }
    issues.push(...collectClaimIssues(child, candidatePath));
  }
  return issues;
}

function booleanMustBe(value: unknown, expected: boolean, path: string, code: CopilotExecutableProbeSecurityReviewIssueCode): BucketedIssue[] {
  if (value === expected) return [];
  return [issue('blocked', code, path, 'Required boolean proposal precondition is missing or not satisfied.')];
}

function exactSetIssues<T extends string>(
  values: unknown,
  required: ReadonlySet<T>,
  path: string,
  code: CopilotExecutableProbeSecurityReviewIssueCode
): BucketedIssue[] {
  if (!Array.isArray(values)) {
    return [issue('blocked', code, path, 'Required proposal enum array is missing.')];
  }
  const actual = new Set<T>();
  for (const [index, entry] of values.entries()) {
    if (typeof entry !== 'string' || !required.has(entry as T)) {
      return [issue('blocked', code, `${path}[${index}]`, 'Proposal enum array contains an unsupported value.')];
    }
    actual.add(entry as T);
  }
  const matches = actual.size === required.size && [...required].every((entry) => actual.has(entry));
  if (matches) return [];
  return [issue('blocked', code, path, 'Proposal enum array must exactly cover the required classes.')];
}

function targetPlatformIssues(value: unknown): { platforms: CopilotExecutableProbePlatform[]; issues: BucketedIssue[] } {
  const platforms: CopilotExecutableProbePlatform[] = [];
  const issues: BucketedIssue[] = [];
  if (!Array.isArray(value) || value.length === 0) {
    issues.push(issue('blocked', 'invalid-target-platform', '$.targetPlatforms', 'Target platforms must be a non-empty array.'));
    return { platforms, issues };
  }
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PLATFORMS.has(entry as CopilotExecutableProbePlatform)) {
      issues.push(issue('blocked', 'invalid-target-platform', `$.targetPlatforms[${index}]`, 'Target platform is not supported.'));
      return;
    }
    if (seen.has(entry)) {
      issues.push(issue('blocked', 'duplicate-target-platform', `$.targetPlatforms[${index}]`, 'Target platforms must not repeat.'));
      return;
    }
    seen.add(entry);
    platforms.push(entry as CopilotExecutableProbePlatform);
  });
  return { platforms, issues };
}

function commandPolicyIssues(value: unknown): BucketedIssue[] {
  const path = '$.commandPolicy';
  if (!isPlainObject(value)) return [issue('blocked', 'missing-tool-policy', path, 'Command policy must be present.')];
  const issues = collectUnknownKeyIssues(value, COMMAND_POLICY_KEYS, path);

  if (typeof value.permissionMode !== 'string' || !PERMISSION_MODES.has(value.permissionMode as CopilotExecutableProbePermissionMode)) {
    issues.push(issue('blocked', 'missing-tool-policy', `${path}.permissionMode`, 'Permission mode must be explicit.'));
  } else if (value.permissionMode === 'broad-allow-all') {
    issues.push(issue('rejected', 'broad-permission-mode', `${path}.permissionMode`, 'Broad permission modes are not admissible.'));
  } else if (value.permissionMode !== 'minimal-explicit-allowlist') {
    issues.push(issue('blocked', 'missing-tool-policy', `${path}.permissionMode`, 'Minimal explicit allowlist mode is required.'));
  }

  issues.push(...exactSetIssues(value.allowedToolClasses, REQUIRED_ALLOWED_TOOL_CLASSES, `${path}.allowedToolClasses`, 'missing-tool-policy'));
  issues.push(...exactSetIssues(value.deniedToolClasses, REQUIRED_DENIED_TOOL_CLASSES, `${path}.deniedToolClasses`, 'missing-denylist'));
  return issues;
}

function environmentPolicyIssues(value: unknown): BucketedIssue[] {
  const path = '$.environmentPolicy';
  if (!isPlainObject(value)) return [issue('blocked', 'missing-environment-policy', path, 'Environment policy must be present.')];
  return [
    ...collectUnknownKeyIssues(value, ENVIRONMENT_POLICY_KEYS, path),
    ...(value.ambientTokenPolicy === 'must-control-or-block'
      ? []
      : [issue('blocked', 'missing-environment-policy', `${path}.ambientTokenPolicy`, 'Ambient-token control policy is required.')]),
    ...booleanMustBe(value.isolatedConfigHomeRequired, true, `${path}.isolatedConfigHomeRequired`, 'missing-environment-policy'),
    ...(value.plaintextFallbackPolicy === 'reject'
      ? []
      : [issue('blocked', 'missing-environment-policy', `${path}.plaintextFallbackPolicy`, 'Plaintext fallback rejection is required.')])
  ];
}

function outputPolicyIssues(value: unknown): BucketedIssue[] {
  const path = '$.outputPolicy';
  if (!isPlainObject(value)) return [issue('blocked', 'missing-output-policy', path, 'Output policy must be present.')];
  return [
    ...collectUnknownKeyIssues(value, OUTPUT_POLICY_KEYS, path),
    ...(value.rawLocalOutputPolicy === 'discard-before-review'
      ? []
      : [issue('blocked', 'missing-output-policy', `${path}.rawLocalOutputPolicy`, 'Raw local output must be discarded before review.')]),
    ...(value.allowedMetadata === 'value-free-enums-only'
      ? []
      : [issue('blocked', 'missing-output-policy', `${path}.allowedMetadata`, 'Only value-free enum metadata may be retained.')]),
    ...booleanMustBe(value.forbidHashesAndFingerprints, true, `${path}.forbidHashesAndFingerprints`, 'missing-output-policy'),
    ...booleanMustBe(value.forbidAccountLabels, true, `${path}.forbidAccountLabels`, 'missing-output-policy')
  ];
}

function cleanupPolicyIssues(value: unknown): BucketedIssue[] {
  const path = '$.cleanupPolicy';
  if (!isPlainObject(value)) return [issue('blocked', 'missing-cleanup-policy', path, 'Cleanup policy must be present.')];
  return [
    ...collectUnknownKeyIssues(value, CLEANUP_POLICY_KEYS, path),
    ...booleanMustBe(value.noMutationExpected, true, `${path}.noMutationExpected`, 'missing-cleanup-policy'),
    ...booleanMustBe(value.cleanupRequired, true, `${path}.cleanupRequired`, 'missing-cleanup-policy'),
    ...booleanMustBe(value.failureTaxonomyRequired, true, `${path}.failureTaxonomyRequired`, 'missing-cleanup-policy')
  ];
}

function reviewPolicyIssues(value: unknown): BucketedIssue[] {
  const path = '$.reviewPolicy';
  if (!isPlainObject(value)) return [issue('blocked', 'missing-review-precondition', path, 'Review policy must be present.')];
  return [
    ...collectUnknownKeyIssues(value, REVIEW_POLICY_KEYS, path),
    ...booleanMustBe(value.appStateCrossCheckRequired, true, `${path}.appStateCrossCheckRequired`, 'missing-review-precondition'),
    ...booleanMustBe(value.switchScenarioRequired, true, `${path}.switchScenarioRequired`, 'missing-review-precondition'),
    ...booleanMustBe(value.docsEvidenceRefreshed, true, `${path}.docsEvidenceRefreshed`, 'stale-docs-evidence'),
    ...booleanMustBe(value.humanRedactionRequired, true, `${path}.humanRedactionRequired`, 'missing-review-precondition')
  ];
}

function statusFor(issues: readonly BucketedIssue[]): CopilotExecutableProbeSecurityReviewStatus {
  if (issues.some((entry) => entry.bucket === 'rejected')) return 'rejected';
  if (issues.some((entry) => entry.bucket === 'deferred')) return 'deferred';
  if (issues.some((entry) => entry.bucket === 'blocked')) return 'blocked';
  return 'eligible-for-implementation-review';
}

export function evaluateCopilotExecutableProbeSecurityReview(
  proposal: unknown
): CopilotExecutableProbeSecurityReviewResult {
  const issues: BucketedIssue[] = [...collectUnsafeIssues(proposal), ...collectClaimIssues(proposal)];
  let targetPlatforms: CopilotExecutableProbePlatform[] = [];

  if (!isPlainObject(proposal)) {
    issues.push(issue('blocked', 'invalid-proposal', '$', 'Proposal must be a value-free object.'));
  } else {
    issues.push(...collectUnknownKeyIssues(proposal, ROOT_KEYS, '$'));
    if (proposal.schemaVersion !== 1) {
      issues.push(issue('blocked', 'invalid-proposal', '$.schemaVersion', 'Proposal schemaVersion must be 1.'));
    }
    if (proposal.subject !== SUBJECT) {
      issues.push(issue('blocked', 'invalid-proposal', '$.subject', 'Proposal subject must be github-copilot-cli.'));
    }
    if (proposal.reviewKind !== REVIEW_KIND) {
      issues.push(issue('blocked', 'invalid-proposal', '$.reviewKind', 'Proposal reviewKind is not supported.'));
    }

    const platformResult = targetPlatformIssues(proposal.targetPlatforms);
    targetPlatforms = platformResult.platforms;
    issues.push(...platformResult.issues);

    if (typeof proposal.collectionIntent !== 'string' || !COLLECTION_INTENTS.has(proposal.collectionIntent as CopilotExecutableProbeCollectionIntent)) {
      issues.push(issue('deferred', 'unsupported-collection-intent', '$.collectionIntent', 'Unsupported collection intent requires separate review.'));
    } else if (proposal.collectionIntent !== 'future-executable-local-probe') {
      issues.push(issue('deferred', 'unsupported-collection-intent', '$.collectionIntent', 'Future collection modes are deferred.'));
    }

    if (proposal.implementationInThisChange === true) {
      issues.push(issue('deferred', 'implementation-requested', '$.implementationInThisChange', 'Implementation must be a separate follow-up.'));
    } else if (proposal.implementationInThisChange !== false) {
      issues.push(issue('blocked', 'implementation-requested', '$.implementationInThisChange', 'Implementation boundary must be explicit.'));
    }
    if (proposal.runnableProbeAdded === true) {
      issues.push(issue('rejected', 'executable-probe-present', '$.runnableProbeAdded', 'Runnable probes are not admissible in this gate.'));
    } else if (proposal.runnableProbeAdded !== false) {
      issues.push(issue('blocked', 'executable-probe-present', '$.runnableProbeAdded', 'Runnable probe boundary must be explicit.'));
    }
    if (proposal.credentialStoreAccessedByMat === true) {
      issues.push(issue('rejected', 'credential-store-accessed-by-mat', '$.credentialStoreAccessedByMat', 'Mat must not access credential stores in this gate.'));
    } else if (proposal.credentialStoreAccessedByMat !== false) {
      issues.push(issue('blocked', 'credential-store-accessed-by-mat', '$.credentialStoreAccessedByMat', 'Credential-store access boundary must be explicit.'));
    }
    if (proposal.productSupportClaimed === true) {
      issues.push(issue('rejected', 'product-support-claim', '$.productSupportClaimed', 'Product support claims are not admissible.'));
    } else if (proposal.productSupportClaimed !== false) {
      issues.push(issue('blocked', 'product-support-claim', '$.productSupportClaimed', 'Product support boundary must be explicit.'));
    }
    if (proposal.platformProofClaimedComplete === true) {
      issues.push(issue('rejected', 'platform-proof-claim', '$.platformProofClaimedComplete', 'Platform proof completion claims are not admissible.'));
    } else if (proposal.platformProofClaimedComplete !== false) {
      issues.push(issue('blocked', 'platform-proof-claim', '$.platformProofClaimedComplete', 'Platform-proof boundary must be explicit.'));
    }

    issues.push(...booleanMustBe(proposal.separateAuthorizationRequired, true, '$.separateAuthorizationRequired', 'missing-review-precondition'));
    issues.push(...booleanMustBe(proposal.localUserOptInRequired, true, '$.localUserOptInRequired', 'missing-review-precondition'));
    issues.push(...booleanMustBe(proposal.secondReviewerRequired, true, '$.secondReviewerRequired', 'missing-review-precondition'));
    issues.push(...commandPolicyIssues(proposal.commandPolicy));
    issues.push(...environmentPolicyIssues(proposal.environmentPolicy));
    issues.push(...outputPolicyIssues(proposal.outputPolicy));
    issues.push(...cleanupPolicyIssues(proposal.cleanupPolicy));
    issues.push(...reviewPolicyIssues(proposal.reviewPolicy));
  }

  const status = statusFor(issues);
  return {
    ok: status === 'eligible-for-implementation-review',
    status,
    productSupport: PRODUCT_SUPPORT,
    platformProof: PLATFORM_PROOF,
    executableProbe: EXECUTABLE_PROBE,
    targetPlatforms,
    issues: issues.map(({ bucket: _bucket, ...entry }) => entry)
  };
}
