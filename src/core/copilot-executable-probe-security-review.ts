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
import {
  isCopilotExecutableProbePlatformProofClaimKey,
  isCopilotExecutableProbeProductSupportClaimKey,
  isCopilotForbiddenEvidenceKey,
  isCopilotRealLabelPresent,
  isCopilotTokenShapePresent,
  normalizeCopilotMetadataKey
} from './copilot-metadata-boundary-taxonomy.js';

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
type DescriptorRecord = Record<PropertyKey, PropertyDescriptor | undefined>;
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

const SAFE_UNSAFE_SCANNER_POLICY_PATHS = new Set([
  '$.outputPolicy.rawLocalOutputPolicy',
  '$.outputPolicy.forbidHashesAndFingerprints'
]);
const ALL_SCHEMA_KEYS = new Set([
  ...ROOT_KEYS,
  ...COMMAND_POLICY_KEYS,
  ...ENVIRONMENT_POLICY_KEYS,
  ...OUTPUT_POLICY_KEYS,
  ...CLEANUP_POLICY_KEYS,
  ...REVIEW_POLICY_KEYS
]);
const DESCRIPTOR_SAFE_UNSAFE_NORMALIZED_KEYS: ReadonlySet<string> = new Set(
  [...ALL_SCHEMA_KEYS].filter((key) => key !== 'rawLocalOutputPolicy').map((key) => normalizeCopilotMetadataKey(key))
);
const MAX_PROPOSAL_SCAN_DEPTH = 64;
const MAX_PROPOSAL_ARRAY_LENGTH = 256;

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  } catch {
    return false;
  }
}

function childPath(path: string, key: string): string {
  return `${path}.${ALL_SCHEMA_KEYS.has(key) ? key : '<unknown-key>'}`;
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
    .filter((finding) => !(finding.kind === 'forbidden-key' && isSafeScannerPolicyFinding(proposal, finding.path)))
    .map((finding) =>
      issue('rejected', 'unsafe-evidence', finding.path, 'Unsafe credential evidence is present; key path only is reported.')
    );
}

function descriptorHasPresentValue(descriptor: PropertyDescriptor | undefined): boolean {
  if (!descriptor) return false;
  if (descriptor.get || descriptor.set) return true;
  const value = descriptor.value;
  return value !== false && value !== null && value !== undefined && !(typeof value === 'string' && value.trim() === '');
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): { known: true; value: unknown } | { known: false } {
  if (!descriptor || descriptor.get || descriptor.set) return { known: false };
  return { known: true, value: descriptor.value };
}

function descriptorFromMap(descriptors: DescriptorRecord, key: PropertyKey): PropertyDescriptor | undefined {
  return descriptors[key];
}

function descriptorHasTrueValue(value: object, key: string, descriptorsByObject: WeakMap<object, DescriptorRecord>): boolean {
  const child = descriptorValue(descriptorsByObject.get(value)?.[key]);
  return child.known && child.value === true;
}

function descriptorSafeChildPath(path: string, key: string, parentIsArray: boolean): string {
  if (parentIsArray && isCanonicalArrayIndexKey(key)) return `${path}[${key}]`;
  if (isCopilotTokenShapePresent(key) || isCopilotRealLabelPresent(key)) return `${path}.<redacted-key>`;
  return childPath(path, key);
}

function isCanonicalArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index <= 4294967294 && String(index) === key;
}

function collectShapeIssues(
  value: unknown,
  path = '$',
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  descriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap(),
  plainObjectsByObject: WeakMap<object, boolean> = new WeakMap()
): BucketedIssue[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return [];
  if (depth > MAX_PROPOSAL_SCAN_DEPTH) {
    return [issue('blocked', 'invalid-proposal', path, 'Proposal metadata exceeds the maximum supported depth.')];
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return [issue('blocked', 'invalid-proposal', path, 'Proposal metadata must be acyclic.')];
  }

  seen.add(objectValue);
  const issues: BucketedIssue[] = [];
  let descriptors: DescriptorRecord;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorRecord;
  } catch {
    seen.delete(objectValue);
    return [issue('blocked', 'invalid-proposal', path, 'Proposal metadata descriptors could not be inspected safely.')];
  }
  descriptorsByObject.set(objectValue, descriptors);

  if (typeof value === 'function') {
    plainObjectsByObject.set(objectValue, false);
    seen.delete(objectValue);
    return [issue('blocked', 'invalid-proposal', path, 'Proposal metadata values must be JSON-like data, not functions.')];
  }

  const isArray = Array.isArray(value);
  const isPlain = !isArray && isPlainObject(value);
  plainObjectsByObject.set(objectValue, isPlain);
  if (!isArray && !isPlain) {
    seen.delete(objectValue);
    return [issue('blocked', 'invalid-proposal', path, 'Proposal metadata must contain only plain objects, arrays, and primitive values.')];
  }
  if (isArray) {
    const lengthDescriptor = descriptors.length;
    const length = typeof lengthDescriptor?.value === 'number' ? lengthDescriptor.value : undefined;
    if (length === undefined) {
      issues.push(issue('blocked', 'invalid-proposal', path, 'Proposal arrays must expose a numeric length.'));
    } else if (!Number.isSafeInteger(length) || length < 0 || length > MAX_PROPOSAL_ARRAY_LENGTH) {
      issues.push(issue('blocked', 'invalid-proposal', path, 'Proposal arrays must stay within the supported size.'));
    } else {
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
          issues.push(issue('blocked', 'invalid-proposal', `${path}[${index}]`, 'Proposal arrays must be dense JSON-like arrays.'));
        }
      }
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') {
      issues.push(issue('blocked', 'invalid-proposal', `${path}.<unknown-key>`, 'Proposal metadata must use string keys only.'));
      continue;
    }
    if (isArray && key === 'length') continue;
    if (isArray && !isCanonicalArrayIndexKey(key)) {
      issues.push(issue('blocked', 'invalid-proposal', descriptorSafeChildPath(path, key, isArray), 'Proposal arrays must not contain non-index fields.'));
      continue;
    }
    const descriptor = descriptorFromMap(descriptors, key);
    const nextPath = descriptorSafeChildPath(path, key, isArray);
    if (!descriptor || descriptor.get || descriptor.set) {
      issues.push(issue('blocked', 'invalid-proposal', nextPath, 'Proposal metadata must not contain accessors.'));
      continue;
    }
    if (!descriptor.enumerable) {
      issues.push(issue('blocked', 'invalid-proposal', nextPath, 'Proposal metadata must not contain hidden non-enumerable fields.'));
      continue;
    }
    issues.push(...collectShapeIssues(descriptor.value, nextPath, seen, depth + 1, descriptorsByObject, plainObjectsByObject));
  }

  seen.delete(objectValue);
  return issues;
}

function isSafeScannerPolicyFinding(proposal: unknown, path: string): boolean {
  if (!SAFE_UNSAFE_SCANNER_POLICY_PATHS.has(path) || !isPlainObject(proposal) || !isPlainObject(proposal.outputPolicy)) {
    return false;
  }
  if (path === '$.outputPolicy.rawLocalOutputPolicy') {
    return proposal.outputPolicy.rawLocalOutputPolicy === 'discard-before-review';
  }
  if (path === '$.outputPolicy.forbidHashesAndFingerprints') {
    return proposal.outputPolicy.forbidHashesAndFingerprints === true;
  }
  return false;
}

function isSafeScannerPolicyDescriptor(path: string, descriptor: PropertyDescriptor | undefined): boolean {
  if (!SAFE_UNSAFE_SCANNER_POLICY_PATHS.has(path) || !descriptor || descriptor.get || descriptor.set) {
    return false;
  }
  if (path === '$.outputPolicy.rawLocalOutputPolicy') {
    return descriptor.value === 'discard-before-review';
  }
  if (path === '$.outputPolicy.forbidHashesAndFingerprints') {
    return descriptor.value === true;
  }
  return false;
}

function unsafeDescriptorIssue(path: string): BucketedIssue {
  return issue('rejected', 'unsafe-evidence', path, 'Unsafe credential evidence is present; key path only is reported.');
}

function collectDescriptorSafeRejectedIssues(
  value: unknown,
  path = '$',
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  descriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap()
): BucketedIssue[] {
  const issues: BucketedIssue[] = [];
  if (typeof value === 'string') {
    if (isCopilotTokenShapePresent(value)) issues.push(unsafeDescriptorIssue(path));
    if (isCopilotRealLabelPresent(value)) issues.push(unsafeDescriptorIssue(path));
    return issues;
  }
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    depth > MAX_PROPOSAL_SCAN_DEPTH ||
    seen.has(value as object)
  ) {
    return issues;
  }

  const isArray = Array.isArray(value);
  const objectValue = value as object;
  const descriptors = descriptorsByObject.get(objectValue);
  if (!descriptors) return issues;

  seen.add(objectValue);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (isArray && key === 'length') continue;

    const descriptor = descriptorFromMap(descriptors, key);
    const child = descriptorValue(descriptor);
    const childPathForIssue = typeof key === 'string' ? descriptorSafeChildPath(path, key, isArray) : `${path}.<redacted-key>`;
    const present = descriptorHasPresentValue(descriptor);

    if (typeof key === 'string' && isCopilotTokenShapePresent(key)) issues.push(unsafeDescriptorIssue(childPathForIssue));
    if (typeof key === 'string' && isCopilotRealLabelPresent(key)) issues.push(unsafeDescriptorIssue(childPathForIssue));

    if (
      typeof key === 'string' &&
      present &&
      !isSafeScannerPolicyDescriptor(childPathForIssue, descriptor) &&
      isCopilotForbiddenEvidenceKey(key, DESCRIPTOR_SAFE_UNSAFE_NORMALIZED_KEYS)
    ) {
      issues.push(unsafeDescriptorIssue(childPathForIssue));
    }

    if (
      typeof key === 'string' &&
      present &&
      !(path === '$' && key === 'productSupportClaimed') &&
      isCopilotExecutableProbeProductSupportClaimKey(key)
    ) {
      issues.push(issue('rejected', 'product-support-claim', childPathForIssue, 'Product support claims are not admissible.'));
    }

    if (
      typeof key === 'string' &&
      present &&
      !(path === '$' && key === 'platformProofClaimedComplete') &&
      isCopilotExecutableProbePlatformProofClaimKey(key)
    ) {
      issues.push(
        issue('rejected', 'platform-proof-claim', childPathForIssue, 'Completed platform-proof claims are not admissible.')
      );
    }

    if (child.known) {
      issues.push(...collectDescriptorSafeRejectedIssues(child.value, childPathForIssue, seen, depth + 1, descriptorsByObject));
    }
  }
  seen.delete(objectValue);
  return issues;
}

function collectDescriptorSafeRootBoundaryIssues(
  proposal: object,
  descriptorsByObject: WeakMap<object, DescriptorRecord>
): BucketedIssue[] {
  const issues: BucketedIssue[] = [];
  if (descriptorHasTrueValue(proposal, 'runnableProbeAdded', descriptorsByObject)) {
    issues.push(issue('rejected', 'executable-probe-present', '$.runnableProbeAdded', 'Runnable probes are not admissible in this gate.'));
  }
  if (descriptorHasTrueValue(proposal, 'credentialStoreAccessedByMat', descriptorsByObject)) {
    issues.push(
      issue('rejected', 'credential-store-accessed-by-mat', '$.credentialStoreAccessedByMat', 'Mat must not access credential stores in this gate.')
    );
  }
  if (descriptorHasTrueValue(proposal, 'productSupportClaimed', descriptorsByObject)) {
    issues.push(issue('rejected', 'product-support-claim', '$.productSupportClaimed', 'Product support claims are not admissible.'));
  }
  if (descriptorHasTrueValue(proposal, 'platformProofClaimedComplete', descriptorsByObject)) {
    issues.push(issue('rejected', 'platform-proof-claim', '$.platformProofClaimedComplete', 'Platform proof completion claims are not admissible.'));
  }
  return issues;
}

function collectClaimIssues(value: unknown, path = '$', seen: WeakSet<object> = new WeakSet()): BucketedIssue[] {
  if (Array.isArray(value)) {
    if (seen.has(value)) return [];
    seen.add(value);
    const issues = value.flatMap((entry, index) => collectClaimIssues(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return issues;
  }
  if (!isPlainObject(value)) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const issues: BucketedIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const candidatePath = childPath(path, key);
    const present = child !== false && child !== null && child !== undefined && !(typeof child === 'string' && child.trim() === '');
    if (present && !(path === '$' && key === 'productSupportClaimed') && isCopilotExecutableProbeProductSupportClaimKey(key)) {
      issues.push(issue('rejected', 'product-support-claim', candidatePath, 'Product support claims are not admissible.'));
    }
    if (present && !(path === '$' && key === 'platformProofClaimedComplete') && isCopilotExecutableProbePlatformProofClaimKey(key)) {
      issues.push(issue('rejected', 'platform-proof-claim', candidatePath, 'Completed platform-proof claims are not admissible.'));
    }
    issues.push(...collectClaimIssues(child, candidatePath, seen));
  }
  seen.delete(value);
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
    if (actual.has(entry as T)) {
      return [issue('blocked', code, `${path}[${index}]`, 'Proposal enum array must not contain duplicate values.')];
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
  const descriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap();
  const plainObjectsByObject: WeakMap<object, boolean> = new WeakMap();
  const shapeIssues = collectShapeIssues(proposal, '$', new WeakSet(), 0, descriptorsByObject, plainObjectsByObject);
  const issues: BucketedIssue[] = [...shapeIssues];
  let targetPlatforms: CopilotExecutableProbePlatform[] = [];
  const descriptorInspectableRoot = proposal !== null && (typeof proposal === 'object' || typeof proposal === 'function');
  const rootIsPlainObject = descriptorInspectableRoot && plainObjectsByObject.get(proposal as object) === true;

  if (!rootIsPlainObject) {
    issues.push(issue('blocked', 'invalid-proposal', '$', 'Proposal must be a value-free object.'));
    if (shapeIssues.length > 0 && descriptorInspectableRoot) {
      issues.push(...collectDescriptorSafeRejectedIssues(proposal, '$', new WeakSet(), 0, descriptorsByObject));
      issues.push(...collectDescriptorSafeRootBoundaryIssues(proposal as object, descriptorsByObject));
    }
  } else if (shapeIssues.length > 0) {
    issues.push(...collectDescriptorSafeRejectedIssues(proposal, '$', new WeakSet(), 0, descriptorsByObject));
    issues.push(...collectDescriptorSafeRootBoundaryIssues(proposal as JsonObject, descriptorsByObject));
  } else {
    const proposalObject = proposal as JsonObject;
    issues.push(...collectUnsafeIssues(proposal), ...collectClaimIssues(proposal));
    issues.push(...collectUnknownKeyIssues(proposalObject, ROOT_KEYS, '$'));
    if (proposalObject.schemaVersion !== 1) {
      issues.push(issue('blocked', 'invalid-proposal', '$.schemaVersion', 'Proposal schemaVersion must be 1.'));
    }
    if (proposalObject.subject !== SUBJECT) {
      issues.push(issue('blocked', 'invalid-proposal', '$.subject', 'Proposal subject must be github-copilot-cli.'));
    }
    if (proposalObject.reviewKind !== REVIEW_KIND) {
      issues.push(issue('blocked', 'invalid-proposal', '$.reviewKind', 'Proposal reviewKind is not supported.'));
    }

    const platformResult = targetPlatformIssues(proposalObject.targetPlatforms);
    targetPlatforms = platformResult.platforms;
    issues.push(...platformResult.issues);

    if (
      typeof proposalObject.collectionIntent !== 'string' ||
      !COLLECTION_INTENTS.has(proposalObject.collectionIntent as CopilotExecutableProbeCollectionIntent)
    ) {
      issues.push(issue('deferred', 'unsupported-collection-intent', '$.collectionIntent', 'Unsupported collection intent requires separate review.'));
    } else if (proposalObject.collectionIntent !== 'future-executable-local-probe') {
      issues.push(issue('deferred', 'unsupported-collection-intent', '$.collectionIntent', 'Future collection modes are deferred.'));
    }

    if (proposalObject.implementationInThisChange === true) {
      issues.push(issue('deferred', 'implementation-requested', '$.implementationInThisChange', 'Implementation must be a separate follow-up.'));
    } else if (proposalObject.implementationInThisChange !== false) {
      issues.push(issue('blocked', 'implementation-requested', '$.implementationInThisChange', 'Implementation boundary must be explicit.'));
    }
    if (proposalObject.runnableProbeAdded === true) {
      issues.push(issue('rejected', 'executable-probe-present', '$.runnableProbeAdded', 'Runnable probes are not admissible in this gate.'));
    } else if (proposalObject.runnableProbeAdded !== false) {
      issues.push(issue('blocked', 'executable-probe-present', '$.runnableProbeAdded', 'Runnable probe boundary must be explicit.'));
    }
    if (proposalObject.credentialStoreAccessedByMat === true) {
      issues.push(issue('rejected', 'credential-store-accessed-by-mat', '$.credentialStoreAccessedByMat', 'Mat must not access credential stores in this gate.'));
    } else if (proposalObject.credentialStoreAccessedByMat !== false) {
      issues.push(issue('blocked', 'credential-store-accessed-by-mat', '$.credentialStoreAccessedByMat', 'Credential-store access boundary must be explicit.'));
    }
    if (proposalObject.productSupportClaimed === true) {
      issues.push(issue('rejected', 'product-support-claim', '$.productSupportClaimed', 'Product support claims are not admissible.'));
    } else if (proposalObject.productSupportClaimed !== false) {
      issues.push(issue('blocked', 'product-support-claim', '$.productSupportClaimed', 'Product support boundary must be explicit.'));
    }
    if (proposalObject.platformProofClaimedComplete === true) {
      issues.push(issue('rejected', 'platform-proof-claim', '$.platformProofClaimedComplete', 'Platform proof completion claims are not admissible.'));
    } else if (proposalObject.platformProofClaimedComplete !== false) {
      issues.push(issue('blocked', 'platform-proof-claim', '$.platformProofClaimedComplete', 'Platform-proof boundary must be explicit.'));
    }

    issues.push(...booleanMustBe(proposalObject.separateAuthorizationRequired, true, '$.separateAuthorizationRequired', 'missing-review-precondition'));
    issues.push(...booleanMustBe(proposalObject.localUserOptInRequired, true, '$.localUserOptInRequired', 'missing-review-precondition'));
    issues.push(...booleanMustBe(proposalObject.secondReviewerRequired, true, '$.secondReviewerRequired', 'missing-review-precondition'));
    issues.push(...commandPolicyIssues(proposalObject.commandPolicy));
    issues.push(...environmentPolicyIssues(proposalObject.environmentPolicy));
    issues.push(...outputPolicyIssues(proposalObject.outputPolicy));
    issues.push(...cleanupPolicyIssues(proposalObject.cleanupPolicy));
    issues.push(...reviewPolicyIssues(proposalObject.reviewPolicy));
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
