import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  createCopilotHumanEvidencePackageTemplate,
  evaluateCopilotHumanEvidencePackage,
  type CopilotHumanEvidencePackageRequest
} from '../../src/core/copilot-human-evidence-package.js';
import type { CopilotCredentialProofReport } from '../../src/core/copilot-credential-proof.js';
import type { CopilotProofReviewChecklistV1 } from '../../src/core/copilot-proof-metadata-admission.js';

const fixtureDir = new URL('../fixtures/copilot-credential-proof/', import.meta.url);
const sourceUrl = new URL('../../src/core/copilot-human-evidence-package.ts', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), 'utf8');
}

function baseReport(): CopilotCredentialProofReport {
  const report = JSON.parse(fixture('valid-macos-linux-windows-blocked.json')) as CopilotCredentialProofReport;
  delete report.notes;
  return report;
}

function windowsPassReport(): CopilotCredentialProofReport {
  const report = JSON.parse(fixture('valid-windows-metadata-pass.json')) as CopilotCredentialProofReport;
  delete report.notes;
  return report;
}

function checklist(targetPlatforms: CopilotProofReviewChecklistV1['targetPlatforms']): CopilotProofReviewChecklistV1 {
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

function request(targetPlatforms: CopilotHumanEvidencePackageRequest['targetPlatforms']): CopilotHumanEvidencePackageRequest {
  return {
    scope: 'macos-linux-platform-evidence',
    targetPlatforms
  };
}

function issueCodes(result: ReturnType<typeof evaluateCopilotHumanEvidencePackage>): string[] {
  return result.issues.map((issue) => issue.code);
}

function expectNoEcho(text: string, ...values: string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

describe('Copilot human evidence package', () => {
  it('admits matching macOS/Linux review-package metadata while product support stays blocked', () => {
    const result = evaluateCopilotHumanEvidencePackage(
      request(['darwin-keychain', 'linux-secret-service']),
      baseReport(),
      checklist(['darwin-keychain', 'linux-secret-service'])
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'admissible-metadata-package',
      proofLevel: 'metadata-report-only',
      productSupport: 'blocked',
      issues: [],
      manifest: {
        scope: 'macos-linux-platform-evidence',
        targetPlatforms: ['darwin-keychain', 'linux-secret-service'],
        proofLevel: 'metadata-report-only',
        productSupport: 'blocked'
      },
      admission: {
        ok: true,
        admission: 'admissible-metadata',
        passPlatforms: ['darwin-keychain', 'linux-secret-service']
      }
    });
  });

  it('blocks blank review-package templates because templates are not platform proof', () => {
    const template = createCopilotHumanEvidencePackageTemplate(request(['darwin-keychain']));
    expect(template.ok).toBe(true);
    expect(template.reportTemplate?.platforms).toEqual([
      expect.objectContaining({ platform: 'darwin-keychain', conclusion: 'blocked' })
    ]);
    expect(template.checklistTemplate?.targetPlatforms).toEqual(['darwin-keychain']);

    const result = evaluateCopilotHumanEvidencePackage(
      request(['darwin-keychain']),
      template.reportTemplate,
      template.checklistTemplate
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(issueCodes(result)).toContain('no-pass-platforms');
    expect(result.admission.admission).toBe('admissible-metadata');
  });

  it('admits matching Windows review-package metadata only as blocked product-support metadata', () => {
    const result = evaluateCopilotHumanEvidencePackage(
      {
        scope: 'windows-target-account-guard-review',
        targetPlatforms: ['windows-credential-manager']
      },
      windowsPassReport(),
      checklist(['windows-credential-manager'])
    );

    expect(result).toMatchObject({
      ok: true,
      status: 'admissible-metadata-package',
      proofLevel: 'metadata-report-only',
      productSupport: 'blocked',
      issues: [],
      manifest: {
        scope: 'windows-target-account-guard-review',
        targetPlatforms: ['windows-credential-manager']
      },
      admission: {
        admission: 'admissible-metadata',
        passPlatforms: ['windows-credential-manager'],
        productSupport: 'blocked'
      }
    });
  });

  it('blocks empty, duplicate, mixed, and cross-scope package targets', () => {
    const report = baseReport();
    const macLinuxChecklist = checklist(['darwin-keychain', 'linux-secret-service']);

    expect(issueCodes(evaluateCopilotHumanEvidencePackage(request([]), report, macLinuxChecklist))).toContain('invalid-package-target');
    expect(
      issueCodes(
        evaluateCopilotHumanEvidencePackage(request(['darwin-keychain', 'darwin-keychain']), report, macLinuxChecklist)
      )
    ).toContain('duplicate-package-target');
    expect(
      issueCodes(
        evaluateCopilotHumanEvidencePackage(
          request(['darwin-keychain', 'windows-credential-manager']),
          report,
          macLinuxChecklist
        )
      )
    ).toContain('cross-scope-package-target');
    expect(
      issueCodes(
        evaluateCopilotHumanEvidencePackage(
          { scope: 'windows-target-account-guard-review', targetPlatforms: ['darwin-keychain'] },
          windowsPassReport(),
          checklist(['windows-credential-manager'])
        )
      )
    ).toContain('cross-scope-package-target');
    expect(
      issueCodes(
        evaluateCopilotHumanEvidencePackage(
          {
            scope: 'windows-target-account-guard-review',
            targetPlatforms: ['windows-credential-manager', 'windows-credential-manager']
          },
          windowsPassReport(),
          checklist(['windows-credential-manager'])
        )
      )
    ).toContain('duplicate-package-target');
  });

  it('blocks when checklist targets or report pass-platforms do not match the package manifest', () => {
    const checklistMismatch = evaluateCopilotHumanEvidencePackage(
      request(['darwin-keychain', 'linux-secret-service']),
      baseReport(),
      checklist(['darwin-keychain'])
    );
    expect(checklistMismatch.status).toBe('blocked');
    expect(issueCodes(checklistMismatch)).toContain('manifest-checklist-target-mismatch');
    expect(checklistMismatch.admission.admission).toBe('blocked');

    const passMismatch = evaluateCopilotHumanEvidencePackage(
      request(['darwin-keychain']),
      baseReport(),
      checklist(['darwin-keychain'])
    );
    expect(passMismatch.status).toBe('blocked');
    expect(issueCodes(passMismatch)).toContain('manifest-pass-platform-mismatch');
  });

  it('defers executable collection mode through the delegated admission gate', () => {
    const executable = checklist(['darwin-keychain', 'linux-secret-service']);
    executable.collectionMode = 'executable-local-probe';

    const result = evaluateCopilotHumanEvidencePackage(
      request(['darwin-keychain', 'linux-secret-service']),
      baseReport(),
      executable
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe('deferred');
    expect(result.admission.admission).toBe('deferred');
    expect(result.admission.issues.map((issue) => issue.code)).toContain('unsupported-collection-mode');
  });

  it('rejects unsafe submitted evidence without echoing values', () => {
    const token = ['gh', 'p', '_', 'A'.repeat(24)].join('');
    const result = evaluateCopilotHumanEvidencePackage(
      request(['darwin-keychain', 'linux-secret-service']),
      { ...baseReport(), diagnostic: token },
      checklist(['darwin-keychain', 'linux-secret-service'])
    );
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(result.admission.issues.map((issue) => issue.code)).toContain('unsafe-evidence');
    expectNoEcho(serialized, token);
  });

  it('inherits admission shape safety for cyclic report metadata', () => {
    const report = baseReport() as unknown as Record<string, unknown>;
    report.self = report;

    let result: ReturnType<typeof evaluateCopilotHumanEvidencePackage> | undefined;
    expect(() => {
      result = evaluateCopilotHumanEvidencePackage(
        request(['darwin-keychain', 'linux-secret-service']),
        report,
        checklist(['darwin-keychain', 'linux-secret-service'])
      );
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.status).toBe('blocked');
    expect(result?.admission.validation.ok).toBe(false);
    expect(result?.admission.issues.map((issue) => issue.code)).toContain('validator-failed');
  });

  it('inherits admission shape safety for accessor checklist metadata', () => {
    const unsafeChecklist = { ...checklist(['darwin-keychain', 'linux-secret-service']) } as Record<string, unknown>;
    Object.defineProperty(unsafeChecklist, 'secondReviewerSignedOff', {
      enumerable: true,
      get() {
        throw new Error('getter must not run');
      }
    });

    let result: ReturnType<typeof evaluateCopilotHumanEvidencePackage> | undefined;
    expect(() => {
      result = evaluateCopilotHumanEvidencePackage(
        request(['darwin-keychain', 'linux-secret-service']),
        baseReport(),
        unsafeChecklist
      );
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.status).toBe('blocked');
    expect(result?.admission.targetPlatforms).toEqual([]);
    expect(result?.admission.issues.map((issue) => issue.code)).toContain('invalid-checklist');
  });

  it('keeps the package layer pure and delegated to the existing admission gate', () => {
    const source = readFileSync(sourceUrl, 'utf8');

    expect(source).toContain('evaluateCopilotProofMetadataAdmission');
    expect(source).not.toMatch(/collectCopilotCredentialProofUnsafeEvidence|validateCopilotCredentialProofReport/);
    expect(source).not.toMatch(/node:fs|fs\/promises|node:child_process|child_process/);
    expect(source).not.toMatch(/execFile|spawn\(|\bimport\(|\brequire\(/);
    expect(source).not.toMatch(/\bprocess\b|readFile|writeFile/);
    expect(source).not.toMatch(/os-keyring|windows-credential-manager\.js|windows-credential-source|secret-tool|security\s|Keychain|Secret Service|Credential Manager|gh auth token/);
  });
});
