/**
 * Pure human-review package layer for redacted Copilot platform-evidence metadata.
 *
 * This module does not prove platform behavior, does not add product support,
 * does not add an executable probe, and intentionally performs no local side
 * effect or credential-store access. It only binds an already-redacted report
 * and value-free review checklist to an explicit review-package manifest.
 */

import {
  evaluateCopilotProofMetadataAdmission,
  type CopilotProofMetadataAdmission,
  type CopilotProofMetadataAdmissionResult,
  type CopilotProofReviewChecklistV1
} from './copilot-proof-metadata-admission.js';
import type {
  CopilotCredentialProofPlatform,
  CopilotCredentialProofPlatformReport,
  CopilotCredentialProofProductSupport,
  CopilotCredentialProofLevel,
  CopilotCredentialProofReport
} from './copilot-credential-proof.js';

export type CopilotHumanEvidencePackageScope =
  | 'macos-linux-platform-evidence'
  | 'windows-target-account-guard-review';

export type CopilotHumanEvidencePackageStatus =
  | 'admissible-metadata-package'
  | 'blocked'
  | 'rejected'
  | 'deferred';

export type CopilotHumanEvidencePackageIssueCode =
  | 'invalid-package-scope'
  | 'invalid-package-target'
  | 'duplicate-package-target'
  | 'cross-scope-package-target'
  | 'manifest-checklist-target-mismatch'
  | 'manifest-pass-platform-mismatch'
  | 'no-pass-platforms';

export interface CopilotHumanEvidencePackageIssue {
  code: CopilotHumanEvidencePackageIssueCode;
  path: string;
  message: string;
}

export interface CopilotHumanEvidencePackageRequest {
  scope: CopilotHumanEvidencePackageScope;
  targetPlatforms: CopilotCredentialProofPlatform[];
}

export interface CopilotHumanEvidencePackageManifest {
  schemaVersion: 1;
  subject: 'github-copilot-cli';
  scope: CopilotHumanEvidencePackageScope;
  targetPlatforms: CopilotCredentialProofPlatform[];
  proofLevel: CopilotCredentialProofLevel;
  productSupport: CopilotCredentialProofProductSupport;
}

export interface CopilotHumanEvidencePackageManifestResult {
  ok: boolean;
  manifest?: CopilotHumanEvidencePackageManifest;
  issues: CopilotHumanEvidencePackageIssue[];
}

export interface CopilotHumanEvidencePackageTemplateResult extends CopilotHumanEvidencePackageManifestResult {
  reportTemplate?: CopilotCredentialProofReport;
  checklistTemplate?: CopilotProofReviewChecklistV1;
}

export interface CopilotHumanEvidencePackageEvaluationResult {
  ok: boolean;
  status: CopilotHumanEvidencePackageStatus;
  proofLevel: CopilotCredentialProofLevel;
  productSupport: CopilotCredentialProofProductSupport;
  manifest?: CopilotHumanEvidencePackageManifest;
  issues: CopilotHumanEvidencePackageIssue[];
  admission: CopilotProofMetadataAdmissionResult;
}

type PackageIssueBucket = 'blocked';

interface BucketedPackageIssue extends CopilotHumanEvidencePackageIssue {
  bucket: PackageIssueBucket;
}

const PROOF_LEVEL: CopilotCredentialProofLevel = 'metadata-report-only';
const PRODUCT_SUPPORT: CopilotCredentialProofProductSupport = 'blocked';
const SUBJECT = 'github-copilot-cli';
const SERVICE_NAME = 'copilot-cli';
const TEMPLATE_SERVICE_NAME_SOURCE = 'review-package-template';

const MACOS_LINUX_PLATFORMS = new Set<CopilotCredentialProofPlatform>([
  'darwin-keychain',
  'linux-secret-service'
]);
const WINDOWS_PLATFORMS = new Set<CopilotCredentialProofPlatform>(['windows-credential-manager']);
const ALL_PLATFORMS = new Set<CopilotCredentialProofPlatform>([
  ...MACOS_LINUX_PLATFORMS,
  ...WINDOWS_PLATFORMS
]);
const SCOPES = new Set<CopilotHumanEvidencePackageScope>([
  'macos-linux-platform-evidence',
  'windows-target-account-guard-review'
]);

function issue(
  code: CopilotHumanEvidencePackageIssueCode,
  path: string,
  message: string
): BucketedPackageIssue {
  return { bucket: 'blocked', code, path, message };
}

function samePlatformSet(
  left: readonly CopilotCredentialProofPlatform[],
  right: readonly CopilotCredentialProofPlatform[]
): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((platform) => rightSet.has(platform));
}

function publicIssues(issues: readonly BucketedPackageIssue[]): CopilotHumanEvidencePackageIssue[] {
  return issues.map(({ bucket: _bucket, ...entry }) => entry);
}

function manifestStatusFor(
  admissionStatus: CopilotProofMetadataAdmission,
  packageIssues: readonly BucketedPackageIssue[]
): CopilotHumanEvidencePackageStatus {
  if (admissionStatus === 'rejected') return 'rejected';
  if (admissionStatus === 'deferred') return 'deferred';
  if (admissionStatus === 'blocked' || packageIssues.length > 0) return 'blocked';
  return 'admissible-metadata-package';
}

function allowedTargetsFor(scope: CopilotHumanEvidencePackageScope): ReadonlySet<CopilotCredentialProofPlatform> {
  return scope === 'macos-linux-platform-evidence' ? MACOS_LINUX_PLATFORMS : WINDOWS_PLATFORMS;
}

function validateManifestRequest(request: CopilotHumanEvidencePackageRequest): CopilotHumanEvidencePackageManifestResult {
  const issues: BucketedPackageIssue[] = [];
  const scope = request.scope;
  const validScope = typeof scope === 'string' && SCOPES.has(scope);
  const targets = Array.isArray(request.targetPlatforms) ? request.targetPlatforms : [];
  const validTargets: CopilotCredentialProofPlatform[] = [];

  if (!validScope) {
    issues.push(issue('invalid-package-scope', '$.scope', 'Review-package scope is not supported.'));
  }

  if (targets.length === 0) {
    issues.push(issue('invalid-package-target', '$.targetPlatforms', 'Review-package targets must be non-empty.'));
  }

  const seen = new Set<string>();
  const allowedTargets = validScope ? allowedTargetsFor(scope) : ALL_PLATFORMS;
  targets.forEach((platform, index) => {
    const path = `$.targetPlatforms[${index}]`;
    if (typeof platform !== 'string' || !ALL_PLATFORMS.has(platform as CopilotCredentialProofPlatform)) {
      issues.push(issue('invalid-package-target', path, 'Review-package target platform is not supported.'));
      return;
    }
    if (seen.has(platform)) {
      issues.push(issue('duplicate-package-target', path, 'Review-package targets must not contain duplicates.'));
      return;
    }
    seen.add(platform);
    const typedPlatform = platform as CopilotCredentialProofPlatform;
    if (!allowedTargets.has(typedPlatform)) {
      issues.push(issue('cross-scope-package-target', path, 'Review-package target does not belong to the requested scope.'));
      return;
    }
    validTargets.push(typedPlatform);
  });

  if (validScope && scope === 'windows-target-account-guard-review' && validTargets.length !== 1) {
    issues.push(
      issue(
        'invalid-package-target',
        '$.targetPlatforms',
        'Windows review-package scope requires exactly windows-credential-manager.'
      )
    );
  }

  if (issues.length > 0) {
    return { ok: false, issues: publicIssues(issues) };
  }

  return {
    ok: true,
    issues: [],
    manifest: {
      schemaVersion: 1,
      subject: SUBJECT,
      scope,
      targetPlatforms: validTargets,
      proofLevel: PROOF_LEVEL,
      productSupport: PRODUCT_SUPPORT
    }
  };
}

function templatePlatformReport(platform: CopilotCredentialProofPlatform): CopilotCredentialProofPlatformReport {
  return {
    platform,
    serviceName: SERVICE_NAME,
    serviceNameSource: TEMPLATE_SERVICE_NAME_SOURCE,
    perAccountSelector: {
      status: 'unverified'
    },
    entryCardinality: 'unverified',
    secretValuesObservedByMat: false,
    rawCredentialStoreOutputCommitted: false,
    appStateCrossCheck: 'not-run',
    ambientTokenPolicy: 'policy-documented-implementation-pending',
    ...(platform === 'windows-credential-manager'
      ? {
          windowsCredentialBindingProof: {
            targetName: { status: 'unverified' },
            credentialType: 'generic' as const,
            accountUserNameGuard: { status: 'unverified' }
          }
        }
      : {}),
    conclusion: 'blocked'
  };
}

function checklistTemplateFor(targetPlatforms: CopilotCredentialProofPlatform[]): CopilotProofReviewChecklistV1 {
  return {
    schemaVersion: 1,
    targetPlatforms,
    collectionMode: 'human-reviewed-manual',
    separateAuthorizationRecorded: true,
    localUserOptInRecorded: true,
    rawLocalOutputDiscarded: true,
    credentialStoreAccessedByMat: false,
    productSupportClaimed: false,
    platformProofClaimedComplete: false,
    switchScenarioReviewed: true,
    appStateCrossCheckReviewed: true,
    ambientTokenPolicyReviewed: true,
    secondReviewerSignedOff: true
  };
}

function reportTemplateFor(targetPlatforms: CopilotCredentialProofPlatform[]): CopilotCredentialProofReport {
  return {
    schemaVersion: 1,
    subject: SUBJECT,
    evidenceKind: 'human-reviewed-local-probe',
    observedAt: '1970-01-01T00:00:00.000Z',
    platforms: targetPlatforms.map(templatePlatformReport)
  };
}

function packageBindingIssues(
  manifest: CopilotHumanEvidencePackageManifest | undefined,
  admission: CopilotProofMetadataAdmissionResult
): BucketedPackageIssue[] {
  if (!manifest) return [];

  const issues: BucketedPackageIssue[] = [];
  if (admission.passPlatforms.length === 0) {
    issues.push(
      issue(
        'no-pass-platforms',
        '$.admission.passPlatforms',
        'Review package requires at least one pass-platform in the redacted report metadata.'
      )
    );
  }
  if (!samePlatformSet(admission.targetPlatforms, manifest.targetPlatforms)) {
    issues.push(
      issue(
        'manifest-checklist-target-mismatch',
        '$.checklist.targetPlatforms',
        'Submitted checklist target platforms must exactly match the review-package manifest.'
      )
    );
  }
  if (!samePlatformSet(admission.passPlatforms, manifest.targetPlatforms)) {
    issues.push(
      issue(
        'manifest-pass-platform-mismatch',
        '$.admission.passPlatforms',
        'Submitted report pass platforms must exactly match the review-package manifest.'
      )
    );
  }
  return issues;
}

export function createCopilotHumanEvidencePackageManifest(
  request: CopilotHumanEvidencePackageRequest
): CopilotHumanEvidencePackageManifestResult {
  return validateManifestRequest(request);
}

export function createCopilotHumanEvidencePackageTemplate(
  request: CopilotHumanEvidencePackageRequest
): CopilotHumanEvidencePackageTemplateResult {
  const manifestResult = createCopilotHumanEvidencePackageManifest(request);
  if (!manifestResult.ok || !manifestResult.manifest) return manifestResult;

  return {
    ...manifestResult,
    reportTemplate: reportTemplateFor(manifestResult.manifest.targetPlatforms),
    checklistTemplate: checklistTemplateFor(manifestResult.manifest.targetPlatforms)
  };
}

export function evaluateCopilotHumanEvidencePackage(
  request: CopilotHumanEvidencePackageRequest,
  report: unknown,
  checklist: unknown
): CopilotHumanEvidencePackageEvaluationResult {
  const manifestResult = createCopilotHumanEvidencePackageManifest(request);
  const admission = evaluateCopilotProofMetadataAdmission(report, checklist);
  const manifestIssues = manifestResult.issues.map((entry) => ({ ...entry, bucket: 'blocked' as const }));
  const bindingIssues = packageBindingIssues(manifestResult.manifest, admission);
  const issues = [...manifestIssues, ...bindingIssues];
  const status = manifestStatusFor(admission.admission, issues);

  return {
    ok: status === 'admissible-metadata-package',
    status,
    proofLevel: PROOF_LEVEL,
    productSupport: PRODUCT_SUPPORT,
    ...(manifestResult.manifest ? { manifest: manifestResult.manifest } : {}),
    issues: publicIssues(issues),
    admission
  };
}
