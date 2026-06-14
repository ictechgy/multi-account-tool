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

  it('explains known blocked CLIs such as Antigravity without requiring a CliDef', () => {
    const report = buildCliSupportReport('agy');

    expect(report.cli).toMatchObject({ id: 'agy', kind: 'known-blocked', builtin: false });
    expect(report.sources).toEqual([]);
    expect(report.profileIdentity.status).toBe('unsupported');
    expect(report.capabilities.swap.status).toBe('blocked');
    expect(report.capabilities.sessionStart.status).toBe('blocked');
    expect(JSON.stringify(report)).toMatch(/stable documented credential source contract/);
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
