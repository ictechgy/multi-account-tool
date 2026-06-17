import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  evaluateCopilotProofMetadataAdmission,
  type CopilotProofReviewChecklistV1
} from '../../src/core/copilot-proof-metadata-admission.js';
import type { CopilotCredentialProofReport } from '../../src/core/copilot-credential-proof.js';

const fixtureDir = new URL('../fixtures/copilot-credential-proof/', import.meta.url);
const sourceUrl = new URL('../../src/core/copilot-proof-metadata-admission.ts', import.meta.url);

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

function baseChecklist(): CopilotProofReviewChecklistV1 {
  return {
    schemaVersion: 1,
    targetPlatforms: ['darwin-keychain', 'linux-secret-service'],
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

function issueCodes(report: unknown, checklist: unknown): string[] {
  return evaluateCopilotProofMetadataAdmission(report, checklist).issues.map((issue) => issue.code);
}

function expectNoEcho(text: string, ...values: string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

function nestedObject(depth: number): Record<string, unknown> {
  let value: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

describe('Copilot proof metadata admission gate', () => {
  it('admits synthetic macOS/Linux metadata only as metadata while product support stays blocked', () => {
    const result = evaluateCopilotProofMetadataAdmission(baseReport(), baseChecklist());

    expect(result).toMatchObject({
      ok: true,
      admission: 'admissible-metadata',
      proofLevel: 'metadata-report-only',
      productSupport: 'blocked',
      issues: [],
      passPlatforms: ['darwin-keychain', 'linux-secret-service'],
      targetPlatforms: ['darwin-keychain', 'linux-secret-service']
    });
    expect(result.validation.ok).toBe(true);
  });

  it('blocks missing human-review preconditions without changing validator semantics', () => {
    const checklist = baseChecklist();
    checklist.secondReviewerSignedOff = false;

    const result = evaluateCopilotProofMetadataAdmission(baseReport(), checklist);

    expect(result.ok).toBe(false);
    expect(result.admission).toBe('blocked');
    expect(issueCodes(baseReport(), checklist)).toContain('missing-review-precondition');
    expect(result.validation.ok).toBe(true);
  });

  it('defers executable or unsupported collection modes unless rejected evidence is present', () => {
    const executable = baseChecklist();
    executable.collectionMode = 'executable-local-probe';
    expect(evaluateCopilotProofMetadataAdmission(baseReport(), executable).admission).toBe('deferred');
    expect(issueCodes(baseReport(), executable)).toContain('unsupported-collection-mode');

    const unsupported = baseChecklist() as unknown as Record<string, unknown>;
    unsupported.collectionMode = 'future-mode';
    expect(evaluateCopilotProofMetadataAdmission(baseReport(), unsupported).admission).toBe('deferred');
    expect(issueCodes(baseReport(), unsupported)).toContain('unsupported-collection-mode');
  });

  it('rejects raw-output retention, Mat credential-store access, and support/proof claims', () => {
    const raw = baseChecklist();
    raw.rawLocalOutputDiscarded = false;
    expect(evaluateCopilotProofMetadataAdmission(baseReport(), raw).admission).toBe('rejected');
    expect(issueCodes(baseReport(), raw)).toContain('raw-output-retained');

    const accessed = baseChecklist();
    accessed.credentialStoreAccessedByMat = true;
    expect(evaluateCopilotProofMetadataAdmission(baseReport(), accessed).admission).toBe('rejected');
    expect(issueCodes(baseReport(), accessed)).toContain('credential-store-accessed-by-mat');

    const claimed = baseChecklist();
    claimed.productSupportClaimed = true;
    claimed.platformProofClaimedComplete = true;
    const result = evaluateCopilotProofMetadataAdmission(baseReport(), claimed);
    expect(result.admission).toBe('rejected');
    expect(result.issues.filter((issue) => issue.code === 'product-support-claim').length).toBeGreaterThanOrEqual(2);
  });

  it('rejects unknown checklist keys and unsafe checklist key/value without echoing submitted values', () => {
    const unsafeKey = ['gh', 'p', '_', 'C'.repeat(24)].join('');
    const unsafeValue = ['sk', '-', 'D'.repeat(16)].join('');
    const checklist = {
      ...baseChecklist(),
      extraField: 'synthetic extra value',
      [unsafeKey]: 'synthetic key evidence',
      nested: { value: unsafeValue }
    };

    const result = evaluateCopilotProofMetadataAdmission(baseReport(), checklist);
    const serialized = JSON.stringify(result);

    expect(result.admission).toBe('rejected');
    expect(result.issues.map((issue) => issue.code)).toContain('unknown-checklist-key');
    expect(result.issues.map((issue) => issue.code)).toContain('unsafe-evidence');
    expect(serialized).toContain('$.<redacted-key>');
    expectNoEcho(serialized, unsafeKey, unsafeValue, 'synthetic key evidence');
  });

  it('blocks generic validator structural failures with validator-failed metadata only', () => {
    const badReport = { ...baseReport(), schemaVersion: 2 };
    const result = evaluateCopilotProofMetadataAdmission(badReport, baseChecklist());

    expect(result.admission).toBe('blocked');
    expect(result.ok).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'validator-failed',
          source: 'validator',
          path: '$.schemaVersion',
          validatorCode: 'invalid-schema-version'
        })
      ])
    );
  });

  it('rejects value-bearing support/proof-complete claim attempts in submitted report objects', () => {
    const report = {
      ...baseReport(),
      productSupport: 'enabled',
      proofLevel: 'platform-proof-complete',
      runtimeWiring: { builtin: true }
    };

    const result = evaluateCopilotProofMetadataAdmission(report, baseChecklist());
    const serialized = JSON.stringify(result);

    expect(result.admission).toBe('rejected');
    expect(result.issues.map((issue) => issue.code)).toContain('product-support-claim');
    expect(serialized).toContain('$.productSupport');
    expect(serialized).toContain('$.proofLevel');
    expectNoEcho(serialized, 'enabled', 'platform-proof-complete');
  });

  it('rejects support claims and forbidden evidence when the report is supplied as a JSON string', () => {
    const rawOutput = 'synthetic JSON-string raw output that must not echo';
    const report = JSON.stringify({
      ...baseReport(),
      productSupport: 'enabled',
      rawOutput
    });

    const result = evaluateCopilotProofMetadataAdmission(report, baseChecklist());
    const serialized = JSON.stringify(result);

    expect(result.admission).toBe('rejected');
    expect(result.issues.map((issue) => issue.code)).toContain('product-support-claim');
    expect(result.issues.map((issue) => issue.code)).toContain('unsafe-evidence');
    expect(serialized).toContain('$.productSupport');
    expect(serialized).toContain('$.rawOutput');
    expectNoEcho(serialized, 'enabled', rawOutput);
  });

  it('rejects unsafe values placed at checklist keys whose names are otherwise safe metadata collisions', () => {
    const token = ['sk', '-', 'F'.repeat(16)].join('');
    const checklist = {
      ...baseChecklist(),
      rawLocalOutputDiscarded: token
    };

    const result = evaluateCopilotProofMetadataAdmission(baseReport(), checklist);
    const serialized = JSON.stringify(result);

    expect(result.admission).toBe('rejected');
    expect(result.issues.map((issue) => issue.code)).toContain('unsafe-evidence');
    expect(result.issues.map((issue) => issue.code)).toContain('invalid-checklist');
    expect(serialized).toContain('$.rawLocalOutputDiscarded');
    expectNoEcho(serialized, token);
  });

  it('blocks non-empty report notes and rejects unsafe notes without echoing values', () => {
    const noted = { ...baseReport(), notes: ['synthetic note that is not admissible evidence'] };
    const blocked = evaluateCopilotProofMetadataAdmission(noted, baseChecklist());
    expect(blocked.admission).toBe('blocked');
    expect(blocked.issues.map((issue) => issue.code)).toContain('non-empty-report-notes');

    const realLookingLabel = ['person', '@', 'example', '.', 'com'].join('');
    const unsafe = { ...baseReport(), notes: [realLookingLabel] };
    const rejected = evaluateCopilotProofMetadataAdmission(unsafe, baseChecklist());
    const serialized = JSON.stringify(rejected);
    expect(rejected.admission).toBe('rejected');
    expect(rejected.issues.map((issue) => issue.code)).toContain('unsafe-evidence');
    expectNoEcho(serialized, realLookingLabel);
  });

  it('blocks pass-platform scope mismatch and keeps Windows metadata pass from implying platform proof', () => {
    const missingLinux = baseChecklist();
    missingLinux.targetPlatforms = ['darwin-keychain'];
    expect(evaluateCopilotProofMetadataAdmission(baseReport(), missingLinux).admission).toBe('blocked');
    expect(issueCodes(baseReport(), missingLinux)).toContain('pass-platform-scope-mismatch');

    const windowsChecklist = baseChecklist();
    windowsChecklist.targetPlatforms = ['darwin-keychain', 'linux-secret-service'];
    const windows = evaluateCopilotProofMetadataAdmission(windowsPassReport(), windowsChecklist);
    expect(windows.admission).toBe('blocked');
    expect(windows.passPlatforms).toEqual(['windows-credential-manager']);
    expect(windows.productSupport).toBe('blocked');
  });

  it('prioritizes unsafe rejection over deferred and blocked statuses', () => {
    const token = ['gh', 'p', '_', 'E'.repeat(24)].join('');
    const report = { ...baseReport(), diagnostic: token };
    const checklist = baseChecklist();
    checklist.collectionMode = 'executable-local-probe';
    checklist.secondReviewerSignedOff = false;

    const result = evaluateCopilotProofMetadataAdmission(report, checklist);
    const serialized = JSON.stringify(result);

    expect(result.admission).toBe('rejected');
    expect(result.issues.map((issue) => issue.code)).toContain('unsafe-evidence');
    expect(result.issues.map((issue) => issue.code)).toContain('unsupported-collection-mode');
    expect(result.issues.map((issue) => issue.code)).toContain('missing-review-precondition');
    expectNoEcho(serialized, token);
  });

  it('blocks cyclic report metadata before recursive validator or unsafe scans run', () => {
    const report = baseReport() as unknown as Record<string, unknown>;
    report.self = report;

    let result: ReturnType<typeof evaluateCopilotProofMetadataAdmission> | undefined;
    expect(() => {
      result = evaluateCopilotProofMetadataAdmission(report, baseChecklist());
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.admission).toBe('blocked');
    expect(result?.validation.ok).toBe(false);
    expect(result?.validation.platforms).toEqual([]);
    expect(result?.issues.map((issue) => issue.code)).toContain('validator-failed');
  });

  it('blocks checklist accessors before checklist validation can dereference them', () => {
    const checklist = { ...baseChecklist() } as Record<string, unknown>;
    Object.defineProperty(checklist, 'secondReviewerSignedOff', {
      enumerable: true,
      get() {
        throw new Error('getter must not run');
      }
    });

    let result: ReturnType<typeof evaluateCopilotProofMetadataAdmission> | undefined;
    expect(() => {
      result = evaluateCopilotProofMetadataAdmission(baseReport(), checklist);
    }).not.toThrow();

    expect(result?.ok).toBe(false);
    expect(result?.admission).toBe('blocked');
    expect(result?.targetPlatforms).toEqual([]);
    expect(result?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'invalid-checklist',
          source: 'checklist'
        })
      ])
    );
  });

  it('blocks excessive report depth before recursive scans run', () => {
    const report = { ...baseReport(), nested: nestedObject(70) };

    const result = evaluateCopilotProofMetadataAdmission(report, baseChecklist());

    expect(result.ok).toBe(false);
    expect(result.admission).toBe('blocked');
    expect(result.validation.platforms).toEqual([]);
    expect(result.issues.map((issue) => issue.code)).toContain('validator-failed');
  });

  it('keeps the admission gate source pure and disconnected from local credential access', () => {
    const source = readFileSync(sourceUrl, 'utf8');

    expect(source).not.toMatch(/node:fs|fs\/promises|node:child_process|child_process/);
    expect(source).not.toMatch(/execFile|spawn\(|\bimport\(|\brequire\(/);
    expect(source).not.toMatch(/\bprocess\b|readFile|writeFile/);
    expect(source).not.toMatch(/os-keyring|windows-credential-manager\.js|windows-credential-source|secret-tool|security\s|Keychain|Secret Service|Credential Manager|gh auth token/);
  });
});
