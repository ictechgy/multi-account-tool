import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_DEFS } from '../../src/core/cli-defs.js';
import {
  collectCopilotCredentialProofUnsafeEvidence,
  validateCopilotCredentialProofReport,
  type CopilotCredentialProofReport
} from '../../src/core/copilot-credential-proof.js';

const fixtureDir = new URL('../fixtures/copilot-credential-proof/', import.meta.url);
const sourceUrl = new URL('../../src/core/copilot-credential-proof.ts', import.meta.url);

function fixture(name: string): string {
  return readFileSync(new URL(name, fixtureDir), 'utf8');
}

function baseReport(): CopilotCredentialProofReport {
  return JSON.parse(fixture('valid-macos-linux-windows-blocked.json')) as CopilotCredentialProofReport;
}

function cloneReport(update: (report: CopilotCredentialProofReport) => void): CopilotCredentialProofReport {
  const report = baseReport();
  update(report);
  return report;
}

function codesFor(report: unknown): string[] {
  const result = validateCopilotCredentialProofReport(report);
  return [...result.issues, ...result.platforms.flatMap((platform) => platform.issues)].map((entry) => entry.code);
}

function expectInvalid(report: unknown, code: string): void {
  const result = validateCopilotCredentialProofReport(report);
  expect(result.ok).toBe(false);
  expect(codesFor(report)).toContain(code);
}

function expectNoObservedValue(text: string, ...values: string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

describe('Copilot credential proof report validator', () => {
  it('validates macOS and Linux pass-shaped metadata reports while keeping product support blocked', () => {
    const result = validateCopilotCredentialProofReport(fixture('valid-macos-linux-windows-blocked.json'));

    expect(result).toEqual({
      ok: true,
      structurallyValid: true,
      proofLevel: 'metadata-report-only',
      productSupport: 'blocked',
      issues: [],
      platforms: [
        {
          platform: 'darwin-keychain',
          claimedConclusion: 'pass',
          metadataConclusion: 'metadata-pass',
          issues: []
        },
        {
          platform: 'linux-secret-service',
          claimedConclusion: 'pass',
          metadataConclusion: 'metadata-pass',
          issues: []
        },
        {
          platform: 'windows-credential-manager',
          claimedConclusion: 'blocked',
          metadataConclusion: 'metadata-blocked',
          issues: []
        }
      ]
    });
  });

  it('rejects Windows pass claims even when generic pass fields are present', () => {
    const report = cloneReport((entry) => {
      const windows = entry.platforms[2];
      windows.perAccountSelector = { status: 'verified', fieldName: 'account', valuePolicy: 'synthetic-only' };
      windows.entryCardinality = 'one-per-account';
      windows.appStateCrossCheck = 'matches-redacted-binding';
      windows.ambientTokenPolicy = 'controlled-by-implementation';
      windows.conclusion = 'pass';
    });

    expectInvalid(report, 'windows-pass-blocked');
  });

  it('rejects service-only or hash-policy selector pass claims', () => {
    const serviceOnly = cloneReport((entry) => {
      entry.platforms[0].perAccountSelector.fieldName = 'serviceName';
    });
    expectInvalid(serviceOnly, 'invalid-selector-field');

    const hashPolicy = cloneReport((entry) => {
      entry.platforms[0].perAccountSelector.valuePolicy = 'hash-only-after-review';
    });
    expectInvalid(hashPolicy, 'invalid-selector-value-policy');
  });

  it('fails claimed pass reports with ambiguous cardinality, app-state gaps, or missing ambient policy', () => {
    const aggregate = cloneReport((entry) => {
      entry.platforms[0].entryCardinality = 'aggregate';
    });
    expectInvalid(aggregate, 'inconsistent-pass');

    const multiple = cloneReport((entry) => {
      entry.platforms[0].entryCardinality = 'multiple-ambiguous';
    });
    expectInvalid(multiple, 'inconsistent-pass');

    const appStateNotRun = cloneReport((entry) => {
      entry.platforms[0].appStateCrossCheck = 'not-run';
    });
    expectInvalid(appStateNotRun, 'inconsistent-pass');

    const ambientMissing = cloneReport((entry) => {
      entry.platforms[0].ambientTokenPolicy = 'not-yet-covered';
    });
    expectInvalid(ambientMissing, 'inconsistent-pass');
  });

  it('treats fail and blocked reports as structural metadata only when they do not include forbidden evidence', () => {
    const failed = cloneReport((entry) => {
      entry.platforms[0].conclusion = 'fail';
      entry.platforms[0].entryCardinality = 'aggregate';
    });
    const failedResult = validateCopilotCredentialProofReport(failed);
    expect(failedResult.ok).toBe(true);
    expect(failedResult.platforms[0].metadataConclusion).toBe('metadata-fail');

    const blocked = cloneReport((entry) => {
      entry.platforms[0].conclusion = 'blocked';
      entry.platforms[0].perAccountSelector = { status: 'unverified' };
      entry.platforms[0].entryCardinality = 'unverified';
      entry.platforms[0].appStateCrossCheck = 'not-run';
    });
    const blockedResult = validateCopilotCredentialProofReport(blocked);
    expect(blockedResult.ok).toBe(true);
    expect(blockedResult.platforms[0].metadataConclusion).toBe('metadata-blocked');
  });

  it('rejects secret observation and raw credential output flags', () => {
    const observed = cloneReport((entry) => {
      entry.platforms[0].secretValuesObservedByMat = true;
    });
    expectInvalid(observed, 'invalid-secret-observation');

    const rawOutput = cloneReport((entry) => {
      entry.platforms[0].rawCredentialStoreOutputCommitted = true;
    });
    expectInvalid(rawOutput, 'invalid-raw-output-flag');
  });

  it('rejects token-shaped values and reports only key paths', () => {
    const githubToken = ['gh', 'p', '_', 'A'.repeat(24)].join('');
    const report = cloneReport((entry) => {
      (entry.platforms[0] as unknown as Record<string, unknown>).diagnostic = githubToken;
    });

    const result = validateCopilotCredentialProofReport(report);
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(codesFor(report)).toContain('token-shaped-value');
    expect(serialized).toContain('$.platforms[0].diagnostic');
    expect(result.platforms[0].metadataConclusion).toBe('metadata-fail');
    expectNoObservedValue(serialized, githubToken);
  });

  it('rejects raw-output and secret-like keys with normalized casing/separators', () => {
    const rawTranscript = 'synthetic raw transcript value that must not echo';
    const report = cloneReport((entry) => {
      (entry.platforms[0] as unknown as Record<string, unknown>).raw_output = rawTranscript;
      (entry.platforms[1] as unknown as Record<string, unknown>).access_token = 'synthetic-token-value';
    });

    const result = validateCopilotCredentialProofReport(report);
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(codesFor(report)).toContain('forbidden-evidence-key');
    expect(serialized).toContain('$.platforms[0].raw_output');
    expect(serialized).toContain('$.platforms[1].access_token');
    expectNoObservedValue(serialized, rawTranscript, 'synthetic-token-value');
  });

  it('rejects unknown extra fields including raw output, hash, identity, and organization aliases', () => {
    const values = [
      'synthetic raw transcript value',
      'synthetic token hash',
      'synthetic digest',
      'synthetic login',
      'synthetic organization',
      'synthetic account id'
    ];
    const report = cloneReport((entry) => {
      const target = entry.platforms[0] as unknown as Record<string, unknown>;
      target.rawCredentialStoreOutput = values[0];
      target.tokenHash = values[1];
      target.sha256Digest = values[2];
      target.login = values[3];
      target.organization = values[4];
      target.accountId = values[5];
    });

    const result = validateCopilotCredentialProofReport(report);
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(codesFor(report)).toContain('unknown-key');
    expect(codesFor(report)).toContain('forbidden-evidence-key');
    expect(result.platforms[0].metadataConclusion).toBe('metadata-fail');
    expect(serialized).toContain('$.platforms[0].rawCredentialStoreOutput');
    expect(serialized).toContain('$.platforms[0].tokenHash');
    expect(serialized).toContain('$.platforms[0].sha256Digest');
    expect(serialized).toContain('$.platforms[0].login');
    expect(serialized).toContain('$.platforms[0].organization');
    expect(serialized).toContain('$.platforms[0].accountId');
    expectNoObservedValue(serialized, ...values);
  });

  it('redacts unsafe key names in issue paths without echoing the key text', () => {
    const tokenKey = ['gh', 'p', '_', 'B'.repeat(24)].join('');
    const realLabelKey = ['person', '@', 'example', '.', 'com'].join('');
    const report = cloneReport((entry) => {
      (entry.platforms[0] as unknown as Record<string, unknown>)[tokenKey] = 'synthetic key name evidence';
      (entry.platforms[1] as unknown as Record<string, unknown>)[realLabelKey] = 'synthetic key name evidence';
    });

    const result = validateCopilotCredentialProofReport(report);
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(codesFor(report)).toContain('token-shaped-value');
    expect(codesFor(report)).toContain('real-label-value');
    expect(serialized).toContain('$.platforms[0].<redacted-key>');
    expect(serialized).toContain('$.platforms[1].<redacted-key>');
    expectNoObservedValue(serialized, tokenKey, realLabelKey);
    expect(result.platforms[0].metadataConclusion).toBe('metadata-fail');
    expect(result.platforms[1].metadataConclusion).toBe('metadata-fail');
  });

  it('rejects non-fixture email labels without echoing the label', () => {
    const realLookingLabel = ['person', '@', 'example', '.', 'com'].join('');
    const report = cloneReport((entry) => {
      (entry.platforms[0] as unknown as Record<string, unknown>).label = realLookingLabel;
    });

    const result = validateCopilotCredentialProofReport(report);
    const serialized = JSON.stringify(result);
    expect(result.ok).toBe(false);
    expect(codesFor(report)).toContain('real-label-value');
    expect(serialized).toContain('$.platforms[0].label');
    expectNoObservedValue(serialized, realLookingLabel);
  });

  it('rejects invalid JSON, root, report basics, duplicate platforms, and enum values', () => {
    expect(validateCopilotCredentialProofReport('{bad')).toEqual({
      ok: false,
      structurallyValid: false,
      proofLevel: 'metadata-report-only',
      productSupport: 'blocked',
      issues: [{ code: 'invalid-json', path: '$', message: 'Copilot proof report is not valid JSON.' }],
      platforms: []
    });
    expectInvalid([], 'invalid-root');
    expectInvalid({ ...baseReport(), schemaVersion: 2 }, 'invalid-schema-version');
    expectInvalid({ ...baseReport(), subject: 'other' }, 'invalid-subject');
    expectInvalid({ ...baseReport(), evidenceKind: 'fixture-only' }, 'invalid-evidence-kind');
    expectInvalid({ ...baseReport(), observedAt: '2026-06-15' }, 'invalid-observed-at');
    expectInvalid({ ...baseReport(), notes: [{ text: 'not allowed' }] }, 'invalid-notes');
    expectInvalid({ ...baseReport(), platforms: [] }, 'invalid-platforms');

    const duplicate = cloneReport((entry) => {
      entry.platforms[1].platform = 'darwin-keychain';
    });
    expectInvalid(duplicate, 'duplicate-platform');

    const invalidEnum = cloneReport((entry) => {
      entry.platforms[0].entryCardinality = 'many' as never;
    });
    expectInvalid(invalidEnum, 'invalid-cardinality');
  });

  it('exposes the shared unsafe-evidence scanner for fixture/report hygiene', () => {
    const bad = {
      nested: {
        securityOutput: 'synthetic raw output',
        value: ['sk', '-', 'A'.repeat(16)].join('')
      }
    };

    expect(collectCopilotCredentialProofUnsafeEvidence(bad)).toEqual([
      { kind: 'forbidden-key', path: '$.nested.securityOutput' },
      { kind: 'token-shaped-value', path: '$.nested.value' }
    ]);
  });

  it('keeps the validator pure and avoids product-support wiring', () => {
    const source = readFileSync(sourceUrl, 'utf8');

    expect(source).not.toMatch(/from ['"](?:node:)?(?:fs|fs\/promises|os|process|child_process)['"]/);
    expect(source).not.toMatch(/import\(['"](?:node:)?(?:fs|fs\/promises|os|process|child_process)['"]\)/);
    expect(source).not.toMatch(/\brequire\(|\bcreateRequire\b|globalThis\.process|\bprocess\./);
    expect(source).not.toMatch(/keytar|keyring|libsecret|secret-tool|security\s+(find|dump|unlock)/i);
    expect(source).not.toMatch(/spawn\(|execFile\(|exec\(/);
    expect(BUILTIN_CLI_DEFS.some((def) => def.id === 'copilot')).toBe(false);
  });

  it('keeps committed synthetic fixtures free of tokens, raw output fields, hashes, and real labels', () => {
    for (const name of readdirSync(fixtureDir).filter((entry) => entry.endsWith('.json'))) {
      const text = fixture(name);
      const parsed = JSON.parse(text) as unknown;
      expect(collectCopilotCredentialProofUnsafeEvidence(parsed), `${name} has no unsafe evidence`).toEqual([]);
      const tokenShapeTextPattern = new RegExp(
        [
          'gh[pousr]' + '_',
          'github' + '_pat' + '_',
          'sk' + '-[A-Za-z0-9]',
          'xox[baprs]' + '-',
          'ey' + 'J[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.',
          '[A-Fa-f0-9]{64,}'
        ].join('|'),
        'i'
      );
      expect(text, `${name} has no token-shaped values`).not.toMatch(tokenShapeTextPattern);

      const emailLike = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
      for (const value of emailLike) {
        expect(value, `${name} uses only @fixture.example identities`).toMatch(/@fixture\.example$/);
      }
    }
  });
});
