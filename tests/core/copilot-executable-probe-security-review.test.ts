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

function issueCount(result: CopilotExecutableProbeSecurityReviewResult, code: string): number {
  return issueCodes(result).filter((entry) => entry === code).length;
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

    const duplicateAllowlist = baseProposal();
    duplicateAllowlist.commandPolicy.allowedToolClasses = [
      ...duplicateAllowlist.commandPolicy.allowedToolClasses,
      'redaction-only'
    ];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(duplicateAllowlist))).toContain('missing-tool-policy');

    const duplicateDenylist = baseProposal();
    duplicateDenylist.commandPolicy.deniedToolClasses = [
      ...duplicateDenylist.commandPolicy.deniedToolClasses,
      'source-schema-wiring'
    ];
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(duplicateDenylist))).toContain('missing-denylist');

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
    expect(issueCount(claimedResult, 'product-support-claim')).toBe(1);
    expect(issueCount(claimedResult, 'platform-proof-claim')).toBe(1);

    const broad = baseProposal();
    broad.commandPolicy.permissionMode = 'broad-allow-all';
    expect(issueCodes(evaluateCopilotExecutableProbeSecurityReview(broad))).toContain('broad-permission-mode');
  });

  it('keeps executable-review claim taxonomy gate-specific while preserving root preconditions', () => {
    const sourceType = { ...baseProposal(), sourceType: 'metadata-only' } as unknown as Record<string, unknown>;
    const sourceTypeResult = evaluateCopilotExecutableProbeSecurityReview(sourceType);

    expect(sourceTypeResult.status).toBe('rejected');
    expect(issueCodes(sourceTypeResult)).toContain('unknown-proposal-key');
    expect(issueCodes(sourceTypeResult)).not.toContain('product-support-claim');

    const nestedProof = {
      ...baseProposal(),
      reviewPolicy: { ...baseProposal().reviewPolicy, platformProof: true }
    };
    const nestedProofResult = evaluateCopilotExecutableProbeSecurityReview(nestedProof);

    expect(issueCodes(nestedProofResult)).toContain('unknown-proposal-key');
    expect(issueCodes(nestedProofResult)).toContain('platform-proof-claim');
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
    const nestedKey = ['gh', 'p', '_', 'D'.repeat(24)].join('');
    const rawOutput = 'synthetic raw transcript that must not echo';
    const proposal = {
      ...baseProposal(),
      diagnostic: token,
      [key]: rawOutput,
      [nestedKey]: { productSupport: true }
    };

    const result = evaluateCopilotExecutableProbeSecurityReview(proposal);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(issueCodes(result)).toContain('unknown-proposal-key');
    expect(serialized).toContain('$.<redacted-key>');
    expect(serialized).toContain('$.<unknown-key>');
    expectNoEcho(serialized, token, key, nestedKey, rawOutput);
  });

  it('rejects unsafe raw output policy values while allowing the safe policy literal', () => {
    const safe = baseProposal();
    expect(evaluateCopilotExecutableProbeSecurityReview(safe).status).toBe('eligible-for-implementation-review');

    const unsafe = baseProposal() as unknown as { outputPolicy: { rawLocalOutputPolicy: unknown } };
    unsafe.outputPolicy.rawLocalOutputPolicy = 'raw transcript retained';
    const result = evaluateCopilotExecutableProbeSecurityReview(unsafe);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(issueCodes(result)).toContain('missing-output-policy');
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

  it('returns structured invalid metadata instead of recursing forever on cyclic objects', () => {
    const cyclic = baseProposal() as unknown as Record<string, unknown>;
    cyclic.self = cyclic;

    const result = evaluateCopilotExecutableProbeSecurityReview(cyclic);

    expect(result.status).toBe('blocked');
    expect(issueCodes(result)).toContain('invalid-proposal');
    expect(JSON.stringify(result)).toContain('Proposal metadata must be acyclic.');
  });

  it('rejects safely inspectable unsafe evidence and claims even when proposal shape is invalid', () => {
    const token = ['gh', 'p', '_', 'E'.repeat(24)].join('');
    const cyclic = {
      ...baseProposal(),
      diagnostic: token,
      productSupport: true,
      reviewPolicy: { ...baseProposal().reviewPolicy, platformProof: true }
    } as Record<string, unknown>;
    cyclic.self = cyclic;

    const result = evaluateCopilotExecutableProbeSecurityReview(cyclic);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('invalid-proposal');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(issueCodes(result)).toContain('product-support-claim');
    expect(issueCodes(result)).toContain('platform-proof-claim');
    expectNoEcho(serialized, token);
  });

  it('rejects safely inspectable symbol-keyed values without echoing symbol details', () => {
    const token = ['gh', 'p', '_', 'S'.repeat(24)].join('');
    const symbolKey = Symbol('real.user@example.com');
    const symbolBacked = baseProposal() as unknown as Record<PropertyKey, unknown>;
    Object.defineProperty(symbolBacked, symbolKey, {
      enumerable: true,
      value: token
    });

    const result = evaluateCopilotExecutableProbeSecurityReview(symbolBacked);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('invalid-proposal');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'unsafe-evidence', path: '$.<redacted-key>' })]));
    expectNoEcho(serialized, token, 'real.user@example.com');
  });

  it('rejects non-enumerable unsafe evidence and claims that normal scanners would skip', () => {
    const token = ['sk', '-', 'H'.repeat(16)].join('');
    const hidden = baseProposal() as unknown as Record<string, unknown>;
    Object.defineProperty(hidden, 'diagnostic', {
      enumerable: false,
      value: token
    });
    Object.defineProperty(hidden, 'productSupport', {
      enumerable: false,
      value: true
    });

    const result = evaluateCopilotExecutableProbeSecurityReview(hidden);
    const serialized = JSON.stringify(result);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('invalid-proposal');
    expect(issueCodes(result)).toContain('unsafe-evidence');
    expect(issueCodes(result)).toContain('product-support-claim');
    expectNoEcho(serialized, token);
  });

  it('preserves rejected root boundary flags even when proposal shape is invalid', () => {
    const cyclic = {
      ...baseProposal(),
      runnableProbeAdded: true,
      credentialStoreAccessedByMat: true,
      productSupportClaimed: true,
      platformProofClaimedComplete: true
    } as Record<string, unknown>;
    cyclic.self = cyclic;

    const result = evaluateCopilotExecutableProbeSecurityReview(cyclic);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toEqual(
      expect.arrayContaining([
        'invalid-proposal',
        'executable-probe-present',
        'credential-store-accessed-by-mat',
        'product-support-claim',
        'platform-proof-claim'
      ])
    );
  });

  it('blocks sparse arrays and rejects unsafe array side-properties before normal array iteration can skip them', () => {
    const sparseTargets: unknown[] = [];
    sparseTargets[1] = 'darwin-keychain';
    const sparse = { ...baseProposal(), targetPlatforms: sparseTargets };

    const sparseResult = evaluateCopilotExecutableProbeSecurityReview(sparse);

    expect(sparseResult.status).toBe('blocked');
    expect(sparseResult.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-proposal', path: '$.targetPlatforms[0]' })])
    );

    const token = ['gh', 'p', '_', 'A'.repeat(24)].join('');
    const sidePropertyTargets = ['darwin-keychain', 'linux-secret-service'];
    Object.defineProperty(sidePropertyTargets, 'diagnostic', {
      enumerable: true,
      value: token
    });

    const sidePropertyResult = evaluateCopilotExecutableProbeSecurityReview({
      ...baseProposal(),
      targetPlatforms: sidePropertyTargets
    });
    const serialized = JSON.stringify(sidePropertyResult);

    expect(sidePropertyResult.status).toBe('rejected');
    expect(issueCodes(sidePropertyResult)).toContain('invalid-proposal');
    expect(issueCodes(sidePropertyResult)).toContain('unsafe-evidence');
    expectNoEcho(serialized, token);
  });

  it('blocks non-plain nested objects and descriptor inspection failures without throwing', () => {
    const nonPlainResult = evaluateCopilotExecutableProbeSecurityReview({
      ...baseProposal(),
      reviewPolicy: new Date('2026-01-01T00:00:00.000Z')
    });

    expect(nonPlainResult.status).toBe('blocked');
    expect(nonPlainResult.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-proposal', path: '$.reviewPolicy' })])
    );

    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error('descriptor trap must not escape');
        }
      }
    );

    let hostileResult: ReturnType<typeof evaluateCopilotExecutableProbeSecurityReview> | undefined;
    expect(() => {
      hostileResult = evaluateCopilotExecutableProbeSecurityReview({ ...baseProposal(), reviewPolicy: hostile });
    }).not.toThrow();
    expect(hostileResult?.status).toBe('blocked');
    expect(hostileResult?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'invalid-proposal', path: '$.reviewPolicy' })])
    );
  });

  it('rejects accessor-backed claims without invoking the accessor', () => {
    const accessorBacked = baseProposal() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorBacked, 'productSupport', {
      enumerable: true,
      get: () => {
        throw new Error('accessor must not run');
      }
    });

    const result = evaluateCopilotExecutableProbeSecurityReview(accessorBacked);

    expect(result.status).toBe('rejected');
    expect(issueCodes(result)).toContain('invalid-proposal');
    expect(issueCodes(result)).toContain('product-support-claim');
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
