import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  evaluateCopilotExecutableProbeSecurityReview,
  type CopilotExecutableProbeSecurityReviewProposalV1,
  type CopilotExecutableProbeSecurityReviewResult
} from '../../src/core/copilot-executable-probe-security-review.js';

const sourceUrl = new URL('../../src/core/copilot-executable-probe-security-review.ts', import.meta.url);

function baseProposal(): CopilotExecutableProbeSecurityReviewProposalV1 {
  return {
    schemaVersion: 1,
    subject: 'github-copilot-cli',
    reviewKind: 'executable-probe-security-review',
    targetPlatforms: ['darwin-keychain', 'linux-secret-service'],
    collectionIntent: 'future-executable-local-probe',
    implementationInThisChange: false,
    runnableProbeAdded: false,
    credentialStoreAccessedByMat: false,
    productSupportClaimed: false,
    platformProofClaimedComplete: false,
    separateAuthorizationRequired: true,
    localUserOptInRequired: true,
    secondReviewerRequired: true,
    commandPolicy: {
      permissionMode: 'minimal-explicit-allowlist',
      allowedToolClasses: [
        'copilot-cli-metadata-only',
        'platform-credential-store-metadata-only',
        'app-state-metadata-only',
        'ambient-env-metadata-only',
        'redaction-only'
      ],
      deniedToolClasses: [
        'raw-credential-output',
        'secret-value-read',
        'shell-transcript-capture',
        'broad-permission-mode',
        'product-runtime-wiring',
        'source-schema-wiring'
      ]
    },
    environmentPolicy: {
      ambientTokenPolicy: 'must-control-or-block',
      isolatedConfigHomeRequired: true,
      plaintextFallbackPolicy: 'reject'
    },
    outputPolicy: {
      rawLocalOutputPolicy: 'discard-before-review',
      allowedMetadata: 'value-free-enums-only',
      forbidHashesAndFingerprints: true,
      forbidAccountLabels: true
    },
    cleanupPolicy: {
      noMutationExpected: true,
      cleanupRequired: true,
      failureTaxonomyRequired: true
    },
    reviewPolicy: {
      appStateCrossCheckRequired: true,
      switchScenarioRequired: true,
      docsEvidenceRefreshed: true,
      humanRedactionRequired: true
    }
  };
}

function issueCodes(result: CopilotExecutableProbeSecurityReviewResult): string[] {
  return result.issues.map((issue) => issue.code);
}

function expectNoEcho(text: string, ...values: string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

describe('Copilot executable probe security review gate', () => {
  it('marks macOS/Linux proposals eligible only for later implementation review', () => {
    const result = evaluateCopilotExecutableProbeSecurityReview(baseProposal());

    expect(result).toEqual({
      ok: true,
      status: 'eligible-for-implementation-review',
      productSupport: 'blocked',
      platformProof: 'not-proven',
      executableProbe: 'not-added',
      targetPlatforms: ['darwin-keychain', 'linux-secret-service'],
      issues: []
    });
  });

  it('supports a value-free Windows proposal without implying Windows product support', () => {
    const proposal = baseProposal();
    proposal.targetPlatforms = ['windows-credential-manager'];

    const result = evaluateCopilotExecutableProbeSecurityReview(proposal);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('eligible-for-implementation-review');
    expect(result.targetPlatforms).toEqual(['windows-credential-manager']);
    expect(result.productSupport).toBe('blocked');
    expect(result.platformProof).toBe('not-proven');
  });

  it('blocks invalid, duplicate, and empty target platform metadata', () => {
    const empty = baseProposal();
    empty.targetPlatforms = [];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(empty))).toContain('invalid-target-platform');

    const duplicate = baseProposal();
    duplicate.targetPlatforms = ['darwin-keychain', 'darwin-keychain'];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(duplicate))).toContain('duplicate-target-platform');

    const invalid = baseProposal() as unknown as Record<string, unknown>;
    invalid.targetPlatforms = ['darwin-keychain', 'unsupported-platform'];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(invalid))).toContain('invalid-target-platform');
  });

  it('blocks safe but incomplete policy metadata', () => {
    const missingTool = baseProposal();
    missingTool.commandPolicy.allowedToolClasses = ['copilot-cli-metadata-only'];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(missingTool))).toContain('missing-tool-policy');

    const missingDenylist = baseProposal();
    missingDenylist.commandPolicy.deniedToolClasses = ['raw-credential-output'];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(missingDenylist))).toContain('missing-denylist');

    const missingEnvironment = baseProposal();
    missingEnvironment.environmentPolicy.isolatedConfigHomeRequired = false;
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(missingEnvironment))).toContain('missing-environment-policy');

    const missingOutput = baseProposal();
    missingOutput.outputPolicy.forbidAccountLabels = false;
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(missingOutput))).toContain('missing-output-policy');

    const staleDocs = baseProposal();
    staleDocs.reviewPolicy.docsEvidenceRefreshed = false;
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(staleDocs))).toContain('stale-docs-evidence');
  });

  it('rejects runnable probes, Mat credential-store access, product/proof claims, and broad permissions', () => {
    const runnable = baseProposal();
    runnable.runnableProbeAdded = true;
    expect(evaluateCopilotExecutableProbeSecurityReview(runnable).status).toBe('rejected');
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(runnable))).toContain('executable-probe-present');

    const accessed = baseProposal();
    accessed.credentialStoreAccessedByMat = true;
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(accessed))).toContain('credential-store-accessed-by-mat');

    const claimed = baseProposal();
    claimed.productSupportClaimed = true;
    claimed.platformProofClaimedComplete = true;
    const claimedResult = evaluateCopilotExecutableProbeSecurityReview(claimed);
    expect(claimedResult.status).toBe('rejected');
    expect(issueCodes(claimedResult)).toContain('product-support-claim');
    expect(issueCodes(claimedResult)).toContain('platform-proof-claim');

    const broad = baseProposal();
    broad.commandPolicy.permissionMode = 'broad-allow-all';
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(broad))).toContain('broad-permission-mode');
  });

  it('defers unsupported future collection modes and implementation-in-this-change requests', () => {
    const unsupported = baseProposal();
    unsupported.collectionIntent = 'unsupported-future-mode';
    expect(evaluateCopilotExecutableProbeSecurityReview(unsupported).status).toBe('deferred');
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(unsupported))).toContain('unsupported-collection-intent');

    const implementation = baseProposal();
    implementation.implementationInThisChange = true;
    expect(evaluateCopilotExecutableProbeSecurityReview(implementation).status).toBe('deferred');
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(implementation))).toContain('implementation-requested');
  });

  it('rejects unsafe evidence and unknown freeform fields without echoing submitted values', () => {
    const token = ['gh', 'p', '_', 'A'.repeat(24)].join('');
    const key = ['gh', 'p', '_', 'B'.repeat(24)].join('');
    const rawOutput = 'synthetic raw transcript that must not echo';
    const proposal = {
      ...baseProposal(),
      diagnostic: token,
      [key]: rawOutput
    };

    const result = evaluateCopilotExecutableProbeSecurityReview(proposal);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(issueCodes(result)).toContain('unknown-proposal-key');
    expect(serialized).toContain('$.<redacted-key>');
    expect(serialized).toContain('$.<unknown-key>');
    expectNoEcho(serialized, token, key, rawOutput);
  });

  it('prioritizes unsafe rejection over deferred and blocked findings', () => {
    const token = ['sk', '-', 'C'.repeat(16)].join('');
    const proposal = {
      ...baseProposal(),
      diagnostic: token,
      collectionIntent: 'unsupported-future-mode' as const,
      separateAuthorizationRequired: false
    };

    const result = evaluateCopilotExecutableProbeSecurityReview(proposal);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(issueCodes(result)).toContain('unsupported-collection-intent');
    expect(issueCodes(result)).toContain('missing-review-precondition');
    expectNoEcho(serialized, token);
  });

  it('keeps the gate pure and disconnected from executable/product wiring', () => {
    const source = readFileSync(sourceUrl, 'utf8');

    expect(source).toContain('collectCopilotCredentialProofUnsafeEvidence');
    expect(source).not.toMatch(/node:fs|fs\/promises|node:child_process|child_process/);
    expect(source).not.toMatch(/execFile|spawn\(|\bimport\(|\brequire\(/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toMatch(/BUILTIN_CLI_DEFS|SourceType|readSource|writeSource|sourceExists|sessionRun|freshness/);
    expect(source).not.toMatch(/gh auth token|secret-tool|security dump-keychain|cmdkey/);
  });
});
