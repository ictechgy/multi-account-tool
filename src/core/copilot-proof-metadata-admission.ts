/**
 * Pure metadata-admission gate for redacted Copilot proof reports.
 *
 * This module does not prove platform behavior, does not add product support,
 * and intentionally performs no local side-effect or credential-store access.
 * It only evaluates whether redacted metadata is admissible for later human review.
 */

import {
  collectCopilotCredentialProofUnsafeEvidence,
  validateCopilotCredentialProofReport,
  type CopilotCredentialProofIssueCode,
  type CopilotCredentialProofPlatform,
  type CopilotCredentialProofProductSupport,
  type CopilotCredentialProofLevel,
  type CopilotCredentialProofValidationResult
} from './copilot-credential-proof.js';
import {
  isCopilotForbiddenEvidenceKey,
  isCopilotProofMetadataAdmissionClaimKey,
  isCopilotRealLabelPresent,
  isCopilotTokenShapePresent,
  normalizeCopilotMetadataKey
} from './copilot-metadata-boundary-taxonomy.js';

export type CopilotProofReviewCollectionMode =
  | 'human-reviewed-manual'
  | 'executable-local-probe'
  | 'unsupported-future-mode';

export interface CopilotProofReviewChecklistV1 {
  schemaVersion: 1;
  targetPlatforms: CopilotCredentialProofPlatform[];
  collectionMode: CopilotProofReviewCollectionMode;
  separateAuthorizationRecorded: boolean;
  localUserOptInRecorded: boolean;
  rawLocalOutputDiscarded: boolean;
  credentialStoreAccessedByMat: boolean;
  productSupportClaimed: boolean;
  platformProofClaimedComplete: boolean;
  switchScenarioReviewed: boolean;
  appStateCrossCheckReviewed: boolean;
  ambientTokenPolicyReviewed: boolean;
  secondReviewerSignedOff: boolean;
}

export type CopilotProofMetadataAdmission = 'admissible-metadata' | 'blocked' | 'rejected' | 'deferred';

export type CopilotProofMetadataAdmissionIssueCode =
  | 'unsafe-evidence'
  | 'product-support-claim'
  | 'unknown-checklist-key'
  | 'invalid-checklist'
  | 'unsupported-collection-mode'
  | 'raw-output-retained'
  | 'credential-store-accessed-by-mat'
  | 'missing-review-precondition'
  | 'validator-failed'
  | 'pass-platform-scope-mismatch'
  | 'non-empty-report-notes';

export type CopilotProofMetadataAdmissionIssueSource = 'report' | 'checklist' | 'validator';

export interface CopilotProofMetadataAdmissionIssue {
  code: CopilotProofMetadataAdmissionIssueCode;
  source: CopilotProofMetadataAdmissionIssueSource;
  path: string;
  message: string;
  validatorCode?: CopilotCredentialProofIssueCode;
}

export interface CopilotProofMetadataAdmissionResult {
  ok: boolean;
  admission: CopilotProofMetadataAdmission;
  proofLevel: CopilotCredentialProofLevel;
  productSupport: CopilotCredentialProofProductSupport;
  issues: CopilotProofMetadataAdmissionIssue[];
  validation: CopilotCredentialProofValidationResult;
  passPlatforms: CopilotCredentialProofPlatform[];
  targetPlatforms: CopilotCredentialProofPlatform[];
}

type JsonObject = Record<string, unknown>;
type DescriptorRecord = Record<PropertyKey, PropertyDescriptor | undefined>;

type IssueBucket = 'rejected' | 'deferred' | 'blocked';

interface BucketedIssue extends CopilotProofMetadataAdmissionIssue {
  bucket: IssueBucket;
}

interface ShapeScanIssue {
  path: string;
  message: string;
}

const PROOF_LEVEL: CopilotCredentialProofLevel = 'metadata-report-only';
const PRODUCT_SUPPORT: CopilotCredentialProofProductSupport = 'blocked';

const PLATFORMS = new Set<CopilotCredentialProofPlatform>([
  'darwin-keychain',
  'linux-secret-service',
  'windows-credential-manager'
]);

const COLLECTION_MODES = new Set<CopilotProofReviewCollectionMode>([
  'human-reviewed-manual',
  'executable-local-probe',
  'unsupported-future-mode'
]);

const CHECKLIST_KEYS = new Set([
  'schemaVersion',
  'targetPlatforms',
  'collectionMode',
  'separateAuthorizationRecorded',
  'localUserOptInRecorded',
  'rawLocalOutputDiscarded',
  'credentialStoreAccessedByMat',
  'productSupportClaimed',
  'platformProofClaimedComplete',
  'switchScenarioReviewed',
  'appStateCrossCheckReviewed',
  'ambientTokenPolicyReviewed',
  'secondReviewerSignedOff'
]);

const REQUIRED_TRUE_CHECKLIST_KEYS = [
  'separateAuthorizationRecorded',
  'localUserOptInRecorded',
  'switchScenarioReviewed',
  'appStateCrossCheckReviewed',
  'ambientTokenPolicyReviewed',
  'secondReviewerSignedOff'
] as const;

const MAX_ADMISSION_SCAN_DEPTH = 64;
const MAX_ADMISSION_ARRAY_LENGTH = 256;

const REPORT_ROOT_KEYS = new Set(['schemaVersion', 'subject', 'evidenceKind', 'observedAt', 'platforms', 'notes']);
const REPORT_PLATFORM_KEYS = new Set([
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
const REPORT_SELECTOR_KEYS = new Set(['status', 'fieldName', 'valuePolicy']);
const SAFE_REPORT_METADATA_NORMALIZED_KEYS = new Set(
  [...REPORT_ROOT_KEYS, ...REPORT_PLATFORM_KEYS, ...REPORT_SELECTOR_KEYS].map((key) => normalizeKey(key))
);

function isPlainObject(value: unknown): value is JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeKey(key: string): string {
  return normalizeCopilotMetadataKey(key);
}

function isNonEmptyEvidenceValue(value: unknown): boolean {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.keys(value).length > 0;
  return true;
}

function safePathSegment(key: string): string {
  if (isCopilotTokenShapePresent(key) || isCopilotRealLabelPresent(key)) return '<redacted-key>';
  if (/^[A-Za-z_$][A-Za-z0-9_$-]*$/.test(key)) return key;
  return '<redacted-key>';
}

function childPathForKey(path: string, key: string): string {
  return `${path}.${safePathSegment(key)}`;
}

function shapePathForKey(path: string, key: string, parentIsArray: boolean): string {
  if (parentIsArray && isCanonicalArrayIndexKey(key)) return `${path}[${key}]`;
  return childPathForKey(path, key);
}

function isCanonicalArrayIndexKey(key: string): boolean {
  if (!/^(0|[1-9]\d*)$/.test(key)) return false;
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index <= 4294967294 && String(index) === key;
}

function admissionIssue(
  bucket: IssueBucket,
  code: CopilotProofMetadataAdmissionIssueCode,
  source: CopilotProofMetadataAdmissionIssueSource,
  path: string,
  message: string,
  validatorCode?: CopilotCredentialProofIssueCode
): BucketedIssue {
  return {
    bucket,
    code,
    source,
    path,
    message,
    ...(validatorCode ? { validatorCode } : {})
  };
}

function reportForAdmissionScans(report: unknown): unknown {
  if (typeof report !== 'string') return report;
  try {
    return JSON.parse(report) as unknown;
  } catch {
    return report;
  }
}

function collectShapeScanIssues(
  value: unknown,
  path = '$',
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  descriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap()
): ShapeScanIssue[] {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return [];
  if (depth > MAX_ADMISSION_SCAN_DEPTH) {
    return [{ path, message: 'Metadata exceeds the maximum supported depth.' }];
  }
  const objectValue = value as object;
  if (seen.has(objectValue)) {
    return [{ path, message: 'Metadata must be an acyclic tree without shared object references.' }];
  }

  seen.add(objectValue);
  const issues: ShapeScanIssue[] = [];
  let descriptors: DescriptorRecord;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as DescriptorRecord;
  } catch {
    return [{ path, message: 'Metadata object descriptors could not be inspected safely.' }];
  }
  descriptorsByObject.set(objectValue, descriptors);

  if (typeof value === 'function') {
    issues.push({ path, message: 'Metadata values must be JSON-like data, not functions.' });
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptorFromMap(descriptors, key);
      const childPath = typeof key === 'string' ? descriptorSafePathForKey(path, key, false) : `${path}.<redacted-key>`;
      issues.push(...collectDescriptorChildShapeIssues(descriptor, childPath, seen, depth, descriptorsByObject));
    }
    return issues;
  }

  const isArray = Array.isArray(value);
  let plainObject = false;
  try {
    plainObject = isPlainObject(value);
  } catch {
    issues.push({ path, message: 'Metadata object shape could not be inspected safely.' });
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptorFromMap(descriptors, key);
      const childPath = typeof key === 'string' ? descriptorSafePathForKey(path, key, false) : `${path}.<redacted-key>`;
      issues.push(...collectDescriptorChildShapeIssues(descriptor, childPath, seen, depth, descriptorsByObject));
    }
    return issues;
  }
  if (!isArray && !plainObject) {
    issues.push({ path, message: 'Metadata must contain only plain objects, arrays, and primitive values.' });
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptorFromMap(descriptors, key);
      const childPath = typeof key === 'string' ? descriptorSafePathForKey(path, key, false) : `${path}.<redacted-key>`;
      issues.push(...collectDescriptorChildShapeIssues(descriptor, childPath, seen, depth, descriptorsByObject));
    }
    return issues;
  }

  if (isArray) {
    const lengthDescriptor = descriptors.length;
    const length = typeof lengthDescriptor?.value === 'number' ? lengthDescriptor.value : undefined;
    if (length === undefined) {
      issues.push({ path, message: 'Metadata arrays must expose a numeric length.' });
    } else if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ADMISSION_ARRAY_LENGTH) {
      issues.push({ path, message: 'Metadata arrays must stay within the supported admission size.' });
    } else {
      for (let index = 0; index < length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(descriptors, String(index))) {
          issues.push({ path: `${path}[${index}]`, message: 'Metadata arrays must be dense JSON-like arrays.' });
        }
      }
    }
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptorFromMap(descriptors, key);
    const childPath = typeof key === 'string' ? descriptorSafePathForKey(path, key, isArray) : `${path}.<redacted-key>`;
    if (typeof key !== 'string') {
      issues.push({ path: `${path}.<unknown-key>`, message: 'Metadata must use string keys only.' });
      issues.push(...collectDescriptorChildShapeIssues(descriptor, childPath, seen, depth, descriptorsByObject));
      continue;
    }
    if (isArray && key === 'length') continue;
    if (isArray && !isCanonicalArrayIndexKey(key)) {
      issues.push({ path: childPathForKey(path, key), message: 'Metadata arrays must not contain non-index fields.' });
      issues.push(...collectDescriptorChildShapeIssues(descriptor, childPath, seen, depth, descriptorsByObject));
      continue;
    }
    if (!descriptor || descriptor.get || descriptor.set) {
      issues.push({ path: childPath, message: 'Metadata must not contain accessors.' });
      continue;
    }
    if (!descriptor.enumerable) {
      issues.push({ path: childPath, message: 'Metadata must not contain hidden non-enumerable fields.' });
      issues.push(...collectDescriptorChildShapeIssues(descriptor, childPath, seen, depth, descriptorsByObject));
      continue;
    }
    issues.push(...collectShapeScanIssues(descriptor.value, childPath, seen, depth + 1, descriptorsByObject));
  }
  return issues;
}

function collectDescriptorChildShapeIssues(
  descriptor: PropertyDescriptor | undefined,
  childPath: string,
  seen: WeakSet<object>,
  depth: number,
  descriptorsByObject: WeakMap<object, DescriptorRecord>
): ShapeScanIssue[] {
  const child = descriptorValue(descriptor);
  if (!child.known || child.value === null || (typeof child.value !== 'object' && typeof child.value !== 'function')) return [];
  return collectShapeScanIssues(child.value, childPath, seen, depth + 1, descriptorsByObject);
}

function reportShapeIssues(report: unknown, descriptorsByObject: WeakMap<object, DescriptorRecord>): BucketedIssue[] {
  return collectShapeScanIssues(report, '$', new WeakSet(), 0, descriptorsByObject).map((entry) =>
    admissionIssue('blocked', 'validator-failed', 'validator', entry.path, entry.message, 'invalid-root')
  );
}

function checklistShapeIssues(checklist: unknown, descriptorsByObject: WeakMap<object, DescriptorRecord>): BucketedIssue[] {
  return collectShapeScanIssues(checklist, '$', new WeakSet(), 0, descriptorsByObject).map((entry) =>
    admissionIssue('blocked', 'invalid-checklist', 'checklist', entry.path, entry.message)
  );
}

function invalidValidationForShape(issues: readonly BucketedIssue[]): CopilotCredentialProofValidationResult {
  return {
    ok: false,
    structurallyValid: false,
    proofLevel: PROOF_LEVEL,
    productSupport: PRODUCT_SUPPORT,
    issues: issues.map((entry) => ({
      code: entry.validatorCode ?? 'invalid-root',
      path: entry.path,
      message: entry.message
    })),
    platforms: []
  };
}

function isSafeChecklistMetadataPath(path: string): boolean {
  return path === '$.rawLocalOutputDiscarded' || path === '$.ambientTokenPolicyReviewed';
}

function isSafeChecklistMetadataKeyFinding(finding: { kind: string; path: string }): boolean {
  return finding.kind === 'forbidden-key' && isSafeChecklistMetadataPath(finding.path);
}

function collectUnsafeAdmissionIssues(
  value: unknown,
  source: CopilotProofMetadataAdmissionIssueSource
): BucketedIssue[] {
  return collectCopilotCredentialProofUnsafeEvidence(value)
    .filter((finding) => source !== 'checklist' || !isSafeChecklistMetadataKeyFinding(finding))
    .map((finding) =>
      admissionIssue(
        'rejected',
        'unsafe-evidence',
        source,
        finding.path,
        'Unsafe credential evidence is present; key path only is reported.'
      )
    );
}

function isForbiddenEvidenceKey(key: string): boolean {
  return isCopilotForbiddenEvidenceKey(key, SAFE_REPORT_METADATA_NORMALIZED_KEYS);
}

function isValueFreeWindowsBindingProofContainer(path: string, key: string, child: unknown): boolean {
  try {
    return (
      /^\$\.platforms\[\d+\]\.windowsCredentialBindingProof$/.test(path) &&
      (key === 'targetName' || key === 'accountUserNameGuard') &&
      isPlainObject(child)
    );
  } catch {
    return false;
  }
}

function unsafeAdmissionIssue(source: CopilotProofMetadataAdmissionIssueSource, path: string): BucketedIssue {
  return admissionIssue(
    'rejected',
    'unsafe-evidence',
    source,
    path,
    'Unsafe credential evidence is present; key path only is reported.'
  );
}

function descriptorHasNonEmptyEvidenceValue(descriptor: PropertyDescriptor | undefined): boolean {
  if (!descriptor) return false;
  if (descriptor.get || descriptor.set) return true;
  try {
    return isNonEmptyEvidenceValue(descriptor.value);
  } catch {
    return false;
  }
}

function descriptorValue(descriptor: PropertyDescriptor | undefined): { known: true; value: unknown } | { known: false } {
  if (!descriptor || descriptor.get || descriptor.set) return { known: false };
  return { known: true, value: descriptor.value };
}

function descriptorFromMap(descriptors: DescriptorRecord, key: PropertyKey): PropertyDescriptor | undefined {
  return descriptors[key];
}

function descriptorSafePathForKey(path: string, key: string, parentIsArray: boolean): string {
  return shapePathForKey(path, key, parentIsArray);
}

function collectDescriptorSafeRejectedIssues(
  value: unknown,
  source: CopilotProofMetadataAdmissionIssueSource,
  path = '$',
  seen: WeakSet<object> = new WeakSet(),
  depth = 0,
  descriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap()
): BucketedIssue[] {
  const issues: BucketedIssue[] = [];
  if (typeof value === 'string') {
    if (isCopilotTokenShapePresent(value)) issues.push(unsafeAdmissionIssue(source, path));
    if (isCopilotRealLabelPresent(value)) issues.push(unsafeAdmissionIssue(source, path));
    return issues;
  }
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    depth > MAX_ADMISSION_SCAN_DEPTH ||
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
    const childPath = typeof key === 'string' ? descriptorSafePathForKey(path, key, isArray) : `${path}.<redacted-key>`;
    const child = descriptorValue(descriptor);

    if (typeof key === 'string' && isCopilotTokenShapePresent(key)) issues.push(unsafeAdmissionIssue(source, childPath));
    if (typeof key === 'string' && isCopilotRealLabelPresent(key)) issues.push(unsafeAdmissionIssue(source, childPath));

    if (
      typeof key === 'string' &&
      isForbiddenEvidenceKey(key) &&
      !(source === 'checklist' && isSafeChecklistMetadataKeyFinding({ kind: 'forbidden-key', path: childPath })) &&
      !(child.known && isValueFreeWindowsBindingProofContainer(path, key, child.value)) &&
      descriptorHasNonEmptyEvidenceValue(descriptor)
    ) {
      issues.push(unsafeAdmissionIssue(source, childPath));
    }

    if (typeof key === 'string' && isCopilotProofMetadataAdmissionClaimKey(key) && descriptorHasNonEmptyEvidenceValue(descriptor)) {
      issues.push(
        admissionIssue(
          'rejected',
          'product-support-claim',
          source,
          childPath,
          'Product support or completed-proof claim metadata is not admissible in this gate.'
        )
      );
    }

    if (child.known) {
      issues.push(...collectDescriptorSafeRejectedIssues(child.value, source, childPath, seen, depth + 1, descriptorsByObject));
    }
  }

  return issues;
}

function materializeDescriptorSnapshot(
  value: unknown,
  descriptorsByObject: WeakMap<object, DescriptorRecord>,
  seen: WeakMap<object, unknown> = new WeakMap()
): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;

  const objectValue = value as object;
  if (seen.has(objectValue)) return seen.get(objectValue);
  const descriptors = descriptorsByObject.get(objectValue);
  if (!descriptors) return undefined;

  if (Array.isArray(value)) {
    const lengthDescriptor = descriptorValue(descriptors.length);
    const length = lengthDescriptor.known ? lengthDescriptor.value : 0;
    const arrayLength = typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : 0;
    const output: unknown[] = new Array(arrayLength);
    seen.set(objectValue, output);
    for (let index = 0; index < arrayLength; index += 1) {
      const child = descriptorValue(descriptors[String(index)]);
      if (child.known) output[index] = materializeDescriptorSnapshot(child.value, descriptorsByObject, seen);
    }
    return output;
  }

  const output: JsonObject = {};
  seen.set(objectValue, output);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') continue;
    const child = descriptorValue(descriptors[key]);
    if (child.known) output[key] = materializeDescriptorSnapshot(child.value, descriptorsByObject, seen);
  }
  return output;
}

function collectProductClaimIssues(
  value: unknown,
  source: CopilotProofMetadataAdmissionIssueSource,
  path = '$',
  seen: WeakSet<object> = new WeakSet()
): BucketedIssue[] {
  if (Array.isArray(value)) {
    if (seen.has(value)) return [];
    seen.add(value);
    return value.flatMap((entry, index) => collectProductClaimIssues(entry, source, `${path}[${index}]`, seen));
  }
  if (!isPlainObject(value)) return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const issues: BucketedIssue[] = [];
  for (const [key, child] of Object.entries(value)) {
    const childPath = childPathForKey(path, key);
    if (isCopilotProofMetadataAdmissionClaimKey(key) && isNonEmptyEvidenceValue(child)) {
      issues.push(
        admissionIssue(
          'rejected',
          'product-support-claim',
          source,
          childPath,
          'Product support or completed-proof claim metadata is not admissible in this gate.'
        )
      );
    }
    issues.push(...collectProductClaimIssues(child, source, childPath, seen));
  }
  return issues;
}

function validateChecklistShape(checklist: unknown): {
  targetPlatforms: CopilotCredentialProofPlatform[];
  issues: BucketedIssue[];
} {
  const issues: BucketedIssue[] = [];
  const targetPlatforms: CopilotCredentialProofPlatform[] = [];

  if (!isPlainObject(checklist)) {
    issues.push(
      admissionIssue('blocked', 'invalid-checklist', 'checklist', '$', 'Review checklist must be a value-free object.')
    );
    return { targetPlatforms, issues };
  }

  for (const key of Object.keys(checklist)) {
    if (!CHECKLIST_KEYS.has(key)) {
      issues.push(
        admissionIssue(
          'rejected',
          'unknown-checklist-key',
          'checklist',
          childPathForKey('$', key),
          'Unexpected review checklist field is present.'
        )
      );
    }
  }

  if (checklist.schemaVersion !== 1) {
    issues.push(
      admissionIssue(
        'blocked',
        'invalid-checklist',
        'checklist',
        '$.schemaVersion',
        'Review checklist schemaVersion must be 1.'
      )
    );
  }

  if (!Array.isArray(checklist.targetPlatforms) || checklist.targetPlatforms.length === 0) {
    issues.push(
      admissionIssue(
        'blocked',
        'invalid-checklist',
        'checklist',
        '$.targetPlatforms',
        'Review checklist targetPlatforms must be a non-empty platform array.'
      )
    );
  } else {
    const seen = new Set<string>();
    checklist.targetPlatforms.forEach((platform, index) => {
      if (typeof platform !== 'string' || !PLATFORMS.has(platform as CopilotCredentialProofPlatform)) {
        issues.push(
          admissionIssue(
            'blocked',
            'invalid-checklist',
            'checklist',
            `$.targetPlatforms[${index}]`,
            'Review checklist target platform is not supported.'
          )
        );
        return;
      }
      if (seen.has(platform)) {
        issues.push(
          admissionIssue(
            'blocked',
            'invalid-checklist',
            'checklist',
            `$.targetPlatforms[${index}]`,
            'Review checklist target platforms must not contain duplicates.'
          )
        );
        return;
      }
      seen.add(platform);
      targetPlatforms.push(platform as CopilotCredentialProofPlatform);
    });
  }

  const collectionMode = checklist.collectionMode;
  if (typeof collectionMode !== 'string') {
    issues.push(
      admissionIssue(
        'blocked',
        'invalid-checklist',
        'checklist',
        '$.collectionMode',
        'Review checklist collectionMode must be explicit.'
      )
    );
  } else if (!COLLECTION_MODES.has(collectionMode as CopilotProofReviewCollectionMode)) {
    issues.push(
      admissionIssue(
        'deferred',
        'unsupported-collection-mode',
        'checklist',
        '$.collectionMode',
        'Unsupported collection mode requires a separate review.'
      )
    );
  } else if (collectionMode !== 'human-reviewed-manual') {
    issues.push(
      admissionIssue(
        'deferred',
        'unsupported-collection-mode',
        'checklist',
        '$.collectionMode',
        'Executable or future collection modes are deferred to a separate review.'
      )
    );
  }

  for (const key of REQUIRED_TRUE_CHECKLIST_KEYS) {
    if (typeof checklist[key] !== 'boolean') {
      issues.push(
        admissionIssue('blocked', 'invalid-checklist', 'checklist', `$.${key}`, 'Review checklist boolean is missing or invalid.')
      );
    } else if (checklist[key] !== true) {
      issues.push(
        admissionIssue(
          'blocked',
          'missing-review-precondition',
          'checklist',
          `$.${key}`,
          'Required human-review precondition is not recorded.'
        )
      );
    }
  }

  for (const key of ['rawLocalOutputDiscarded', 'credentialStoreAccessedByMat', 'productSupportClaimed', 'platformProofClaimedComplete'] as const) {
    if (typeof checklist[key] !== 'boolean') {
      issues.push(
        admissionIssue('blocked', 'invalid-checklist', 'checklist', `$.${key}`, 'Review checklist boolean is missing or invalid.')
      );
    }
  }

  if (checklist.rawLocalOutputDiscarded === false) {
    issues.push(
      admissionIssue('rejected', 'raw-output-retained', 'checklist', '$.rawLocalOutputDiscarded', 'Raw local output was not discarded.')
    );
  }
  if (checklist.credentialStoreAccessedByMat === true) {
    issues.push(
      admissionIssue(
        'rejected',
        'credential-store-accessed-by-mat',
        'checklist',
        '$.credentialStoreAccessedByMat',
        'Mat must not access a real credential store in this metadata-admission gate.'
      )
    );
  }
  if (checklist.productSupportClaimed === true) {
    issues.push(
      admissionIssue('rejected', 'product-support-claim', 'checklist', '$.productSupportClaimed', 'Product support claims are not admissible.')
    );
  }
  if (checklist.platformProofClaimedComplete === true) {
    issues.push(
      admissionIssue(
        'rejected',
        'product-support-claim',
        'checklist',
        '$.platformProofClaimedComplete',
        'Completed platform-proof claims are not admissible.'
      )
    );
  }

  return {
    targetPlatforms,
    issues
  };
}

function reportNotesIssues(report: unknown): BucketedIssue[] {
  const parsed = reportForAdmissionScans(report);
  if (!isPlainObject(parsed)) return [];
  const notes = parsed.notes;
  if (Array.isArray(notes) && notes.length > 0) {
    return [
      admissionIssue(
        'blocked',
        'non-empty-report-notes',
        'report',
        '$.notes',
        'Report notes must be absent or empty for metadata admission.'
      )
    ];
  }
  return [];
}

function validatorIssues(validation: CopilotCredentialProofValidationResult): BucketedIssue[] {
  const issues = [...validation.issues, ...validation.platforms.flatMap((platform) => platform.issues)];
  return issues.map((entry) => {
    const rejected = entry.code === 'invalid-secret-observation' || entry.code === 'invalid-raw-output-flag';
    return admissionIssue(
      rejected ? 'rejected' : 'blocked',
      rejected ? 'unsafe-evidence' : 'validator-failed',
      'validator',
      entry.path,
      rejected
        ? 'Validator found secret observation or raw credential output metadata.'
        : 'Proof report validator did not accept this metadata package.',
      entry.code
    );
  });
}

function passPlatformsFor(validation: CopilotCredentialProofValidationResult): CopilotCredentialProofPlatform[] {
  const platforms = validation.platforms
    .filter((platform) => platform.claimedConclusion === 'pass' && platform.platform !== 'unknown')
    .map((platform) => platform.platform as CopilotCredentialProofPlatform);
  return [...new Set(platforms)];
}

function platformScopeIssues(
  passPlatforms: readonly CopilotCredentialProofPlatform[],
  targetPlatforms: readonly CopilotCredentialProofPlatform[]
): BucketedIssue[] {
  if (passPlatforms.length === 0 || targetPlatforms.length === 0) return [];
  const passSet = new Set(passPlatforms);
  const targetSet = new Set(targetPlatforms);
  const mismatch = passPlatforms.some((platform) => !targetSet.has(platform)) || targetPlatforms.some((platform) => !passSet.has(platform));
  if (!mismatch) return [];
  return [
    admissionIssue(
      'blocked',
      'pass-platform-scope-mismatch',
      'checklist',
      '$.targetPlatforms',
      'Review checklist target platforms must exactly match pass-claim platforms.'
    )
  ];
}

function admissionFor(issues: readonly BucketedIssue[]): CopilotProofMetadataAdmission {
  if (issues.some((entry) => entry.bucket === 'rejected')) return 'rejected';
  if (issues.some((entry) => entry.bucket === 'deferred')) return 'deferred';
  if (issues.some((entry) => entry.bucket === 'blocked')) return 'blocked';
  return 'admissible-metadata';
}

export function evaluateCopilotProofMetadataAdmission(
  report: unknown,
  checklist: unknown
): CopilotProofMetadataAdmissionResult {
  const reportScanTarget = reportForAdmissionScans(report);
  const reportDescriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap();
  const checklistDescriptorsByObject: WeakMap<object, DescriptorRecord> = new WeakMap();
  const reportShape = reportShapeIssues(reportScanTarget, reportDescriptorsByObject);
  const checklistShapePreflight = checklistShapeIssues(checklist, checklistDescriptorsByObject);
  const reportSemanticTarget =
    reportShape.length > 0 ? reportScanTarget : materializeDescriptorSnapshot(reportScanTarget, reportDescriptorsByObject);
  const checklistSemanticTarget =
    checklistShapePreflight.length > 0 ? checklist : materializeDescriptorSnapshot(checklist, checklistDescriptorsByObject);
  const validation =
    reportShape.length > 0 ? invalidValidationForShape(reportShape) : validateCopilotCredentialProofReport(reportSemanticTarget);
  const checklistShape =
    checklistShapePreflight.length > 0
      ? { targetPlatforms: [] as CopilotCredentialProofPlatform[], issues: checklistShapePreflight }
      : validateChecklistShape(checklistSemanticTarget);
  const passPlatforms = passPlatformsFor(validation);
  const reportShapeRejectedIssues =
    reportShape.length > 0
      ? collectDescriptorSafeRejectedIssues(reportScanTarget, 'report', '$', new WeakSet(), 0, reportDescriptorsByObject)
      : [];
  const checklistShapeRejectedIssues =
    checklistShapePreflight.length > 0
      ? collectDescriptorSafeRejectedIssues(checklist, 'checklist', '$', new WeakSet(), 0, checklistDescriptorsByObject)
      : [];

  const issues: BucketedIssue[] = [
    ...reportShape,
    ...reportShapeRejectedIssues,
    ...(reportShape.length > 0 ? [] : collectUnsafeAdmissionIssues(reportSemanticTarget, 'report')),
    ...checklistShapeRejectedIssues,
    ...(checklistShapePreflight.length > 0 ? [] : collectUnsafeAdmissionIssues(checklistSemanticTarget, 'checklist')),
    ...(reportShape.length > 0 ? [] : collectProductClaimIssues(reportSemanticTarget, 'report')),
    ...(checklistShapePreflight.length > 0 ? [] : collectProductClaimIssues(checklistSemanticTarget, 'checklist')),
    ...checklistShape.issues,
    ...(reportShape.length > 0 ? [] : reportNotesIssues(reportSemanticTarget)),
    ...(reportShape.length > 0 ? [] : validatorIssues(validation)),
    ...platformScopeIssues(passPlatforms, checklistShape.targetPlatforms)
  ];

  const admission = admissionFor(issues);
  const publicIssues = issues.map(({ bucket, ...entry }) => entry);

  return {
    ok: admission === 'admissible-metadata',
    admission,
    proofLevel: PROOF_LEVEL,
    productSupport: PRODUCT_SUPPORT,
    issues: publicIssues,
    validation,
    passPlatforms,
    targetPlatforms: checklistShape.targetPlatforms
  };
}
