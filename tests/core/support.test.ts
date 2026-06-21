import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BUILTIN_CLI_DEFS, resetCliDefCache } from '../../src/core/cli-defs.js';
import { UnknownCliError } from '../../src/core/errors.js';
import { BUILTIN_FRESHNESS_ADAPTER_IDS } from '../../src/core/freshness-adapters/index.js';
import { buildCliSupportReport } from '../../src/core/support.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('support registry — support/explain reports', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    resetCliDefCache();
  });

  afterEach(async () => {
    resetCliDefCache();
    await tmp.cleanup();
  });

  it('reports Codex support from CliDef metadata without exposing source paths', () => {
    const report = buildCliSupportReport('codex');
    expect(report.schemaVersion).toBe(1);
    expect(report.cli).toMatchObject({ id: 'codex', builtin: true, kind: 'builtin' });
    expect(report.capabilities.swap.status).toBe('supported');
    expect(report.capabilities.freshness.status).toBe('supported');
    expect(report.capabilities.sessionStart.status).toBe('supported');
    expect(report.capabilities.sessionRun.status).toBe('supported');
    expect(report.sources).toEqual([{ type: 'file', saveAs: 'auth.json' }]);
    expect(report.profileIdentity.status).toBe('available');
    expect(report.profileIdentity.signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'account', source: 'auth.json', safety: 'masked' })
    ]));
    expect(report.sources).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]));
  });

  it('explains Aider as session-start unsupported and session-run partial', () => {
    const report = buildCliSupportReport('aider');

    expect(report.capabilities.swap.status).toBe('supported');
    expect(report.capabilities.freshness.status).toBe('partial');
    expect(report.capabilities.sessionStart.status).toBe('unsupported');
    expect(report.capabilities.sessionRun.status).toBe('partial');
    expect(JSON.stringify(report)).toMatch(/forced --config/);
  });

  it('explains Grok PR1 as auth.json profile-swap-only without full session isolation claims or raw secret values', () => {
    const report = buildCliSupportReport('grok');
    const serialized = JSON.stringify(report);

    expect(report.cli).toMatchObject({ id: 'grok', name: 'Grok Build', builtin: true, kind: 'builtin' });
    expect(report.sources).toEqual([{ type: 'file', saveAs: 'grok-auth.json' }]);
    expect(report.capabilities.swap.status).toBe('supported');
    expect(report.capabilities.freshness.status).toBe('partial');
    expect(report.capabilities.sessionStart.status).toBe('unsupported');
    expect(report.capabilities.sessionRun.status).toBe('unsupported');
    expect(serialized).toMatch(/auth\.json profile swap|profile-swap|profile swap/i);
    expect(serialized).toContain('XAI_API_KEY');
    expect(serialized).toContain('GROK_*');
    expect(serialized).toContain('project .grok/config.toml');
    expect(serialized).toContain('MCP');
    expect(serialized).toContain('TUI profile switch');
    expect(serialized).not.toContain('mat switch grok');
    expect(serialized).not.toMatch(/full session|full account isolation/i);
    expect(serialized).not.toContain('SECRET');
  });

  it('explains known blocked CLIs such as Antigravity without requiring a CliDef', () => {
    const report = buildCliSupportReport('agy');

    expect(report.cli).toMatchObject({ id: 'agy', kind: 'known-blocked', builtin: false });
    expect(report.sources).toEqual([]);
    expect(report.profileIdentity.status).toBe('unsupported');
    expect(report.capabilities.swap.status).toBe('blocked');
    expect(report.capabilities.freshness.status).toBe('blocked');
    expect(report.capabilities.sessionStart.status).toBe('blocked');
    expect(report.capabilities.sessionRun.status).toBe('blocked');
    expect(report.driftContracts).toEqual([
      expect.objectContaining({
        id: 'agy-blocked-no-contract',
        lastVerified: '2026-06-14',
        evidence: expect.arrayContaining([
          expect.stringMatching(/system keyring auth \+ Google Sign-In fallback/),
          expect.stringMatching(/local agy --version: 1\.0\.8/)
        ])
      })
    ]);
    expect(JSON.stringify(report)).toMatch(/mat-safe auth-store or redirect contract/);
  });

  it('reports plugin CLIs as swap-only with fallback-only freshness', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'sample.json'),
      JSON.stringify({
        id: 'sample',
        name: 'Sample CLI',
        sources: [{ type: 'file', path: '~/.sample/auth.json', saveAs: 'sample-auth.json' }],
        session: { roots: [{ env: 'EVIL_HOME', base: '~/.evil' }] },
        sessionRun: { executable: 'evil' }
      })
    );
    resetCliDefCache();

    const report = buildCliSupportReport('sample');

    expect(report.cli).toMatchObject({ id: 'sample', builtin: false, kind: 'plugin' });
    expect(report.capabilities.swap.status).toBe('supported');
    expect(report.capabilities.freshness.status).toBe('partial');
    expect(report.profileIdentity.status).toBe('unsupported');
    expect(report.capabilities.sessionStart.status).toBe('unsupported');
    expect(report.capabilities.sessionRun.status).toBe('unsupported');
    expect(JSON.stringify(report)).toMatch(/profile-swap only|profile swap/i);
  });

  it('reports plugin env-secret sources as metadata-only blocked without raw backend/account fields', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'future-env.json'),
      JSON.stringify({
        id: 'future-env',
        name: 'Future Env',
        sources: [{
          type: 'env-secret',
          envName: 'MAT_TEST_SECRET',
          saveAs: 'future.json',
          backend: { kind: 'linux-secret-service', handle: 'linux-handle' },
          accountKey: 'linux-account'
        }]
      })
    );
    resetCliDefCache();

    const report = buildCliSupportReport('future-env');
    const serialized = JSON.stringify(report);

    expect(report.cli).toMatchObject({ id: 'future-env', builtin: false, kind: 'plugin' });
    expect(report.capabilities.swap.status).toBe('blocked');
    expect(report.capabilities.freshness.status).toBe('blocked');
    expect(report.capabilities.sessionStart.status).toBe('unsupported');
    expect(report.capabilities.sessionRun.status).toBe('unsupported');
    expect(report.sources).toEqual([{ type: 'env-secret', saveAs: 'future.json' }]);
    expect(serialized).not.toContain('linux-handle');
    expect(serialized).not.toContain('linux-account');
  });

  it('reports plugin win-credential sources as primitive-only blocked on non-win32 without raw target/account fields', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        join(dir, 'future-win.json'),
        JSON.stringify({
          id: 'future-win',
          name: 'Future Win',
          sources: [{
            type: 'win-credential',
            targetName: 'mat/test/future-win-secret-target',
            credentialType: 'generic',
            account: 'future-account',
            persist: 'session',
            saveAs: 'future.json'
          }]
        })
      );
      resetCliDefCache();

      const report = buildCliSupportReport('future-win');
      const serialized = JSON.stringify(report);

      expect(report.cli).toMatchObject({ id: 'future-win', builtin: false, kind: 'plugin' });
      expect(report.capabilities.swap.status).toBe('blocked');
      expect(report.capabilities.freshness.status).toBe('blocked');
      expect(report.sources).toEqual([{ type: 'win-credential', saveAs: 'future.json' }]);
      expect(serialized).toMatch(/win-credential|Windows Credential Manager/);
      expect(serialized).not.toContain('future-win-secret-target');
      expect(serialized).not.toContain('future-account');
    } finally {
      resetCliDefCache();
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('keeps known-blocked ids blocked even if a user plugin uses the same id', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'agy.json'),
      JSON.stringify({
        id: 'agy',
        name: 'User Claimed Agy',
        sources: [{ type: 'file', path: '~/.agy/token', saveAs: 'token.json' }]
      })
    );
    resetCliDefCache();

    const report = buildCliSupportReport('agy');

    expect(report.cli.kind).toBe('known-blocked');
    expect(report.capabilities.swap.status).toBe('blocked');
  });

  it('throws UnknownCliError for truly unknown ids', () => {
    expect(() => buildCliSupportReport('definitely-unknown')).toThrow(UnknownCliError);
  });

  it('keeps registry session claims aligned with CliDef mechanical support', () => {
    for (const def of BUILTIN_CLI_DEFS) {
      const report = buildCliSupportReport(def.id);
      expect(report.sources.map((src) => src.saveAs)).toEqual(def.sources.map((src) => src.saveAs));

      if (!def.session || def.session.roots.length === 0) {
        expect(['unsupported', 'blocked']).toContain(report.capabilities.sessionStart.status);
      }
      if (!def.sessionRun) {
        expect(['unsupported', 'blocked']).toContain(report.capabilities.sessionRun.status);
      }
      if (report.capabilities.sessionStart.status !== 'supported' && def.session) {
        expect([
          ...report.capabilities.sessionStart.reasons,
          ...report.capabilities.sessionStart.caveats
        ].length).toBeGreaterThan(0);
      }
    }
  });

  it('derives adapter-backed freshness claims from the shared builtin adapter id list', () => {
    for (const id of BUILTIN_FRESHNESS_ADAPTER_IDS) {
      expect(buildCliSupportReport(id).capabilities.freshness.status).toBe('supported');
    }
    expect(buildCliSupportReport('aider').capabilities.freshness.status).toBe('partial');
  });
});
