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

  it('reports Qwen session start as advisory-only and session run as unsupported', () => {
    const report = buildCliSupportReport('qwen');
    const serialized = JSON.stringify(report);

    expect(report.capabilities.sessionStart.status).toBe('partial');
    expect(report.capabilities.sessionStart.summary).toMatch(/advisory/i);
    expect(report.capabilities.sessionStart.caveats.join(' ')).toMatch(/ambient detection.*switch.*exec.*doctor/i);
    expect(report.capabilities.sessionRun.status).toBe('unsupported');
    expect(serialized).toMatch(/v0\.19\.10/);
    expect(report.nextSteps).toEqual(expect.arrayContaining([
      expect.stringMatching(/mat exec qwen <profile>/)
    ]));
    expect(report.nextSteps.join(' ')).not.toMatch(/session start qwen.*concurrent isolated sessions/i);
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
    expect(report.sources).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: expect.any(String) })]));
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
    expect(serialized).not.toContain('custom-token');
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
        lastVerified: '2026-07-15',
        evidence: expect.arrayContaining([
          expect.stringMatching(/system keyring auth \+ Google Sign-In fallback/),
          expect.stringMatching(/local agy --version: 1\.1\.2/)
        ])
      })
    ]);
    expect(JSON.stringify(report)).toMatch(/mat-safe auth-store or redirect contract/);
  });

  it('resolves builtin and known-blocked reports without loading user plugins', async () => {
    const dir = join(tmp.home, '.multi-account-tool', 'cli-defs');
    await fs.mkdir(dir, { recursive: true });
    const samplePath = join(dir, 'sample.json');
    await fs.writeFile(
      samplePath,
      JSON.stringify({
        id: 'sample',
        name: 'Sample CLI',
        sources: [{ type: 'file', path: '~/.sample/auth.json', saveAs: 'sample-auth.json' }]
      })
    );
    resetCliDefCache();

    expect(buildCliSupportReport('grok').cli.kind).toBe('builtin');
    expect(buildCliSupportReport('agy').cli.kind).toBe('known-blocked');

    await fs.unlink(samplePath);
    expect(() => buildCliSupportReport('sample')).toThrow(UnknownCliError);
  });

  it('falls back to derived builtin support when registry metadata is absent', () => {
    const synthetic = {
      id: 'synthetic-builtin',
      name: 'Synthetic Builtin',
      sources: [{ type: 'file' as const, path: '~/.synthetic/auth.json', saveAs: 'auth.json' }]
    };
    const insertAt = BUILTIN_CLI_DEFS.length;
    BUILTIN_CLI_DEFS.push(synthetic);
    try {
      const report = buildCliSupportReport('synthetic-builtin');

      expect(report.cli).toMatchObject({ id: 'synthetic-builtin', builtin: true, kind: 'builtin' });
      expect(report.capabilities.swap.status).toBe('supported');
      expect(report.capabilities.freshness.status).toBe('partial');
      expect(report.capabilities.sessionStart.status).toBe('unsupported');
      expect(report.capabilities.sessionRun.status).toBe('unsupported');
    } finally {
      BUILTIN_CLI_DEFS.splice(insertAt, BUILTIN_CLI_DEFS.length - insertAt);
    }
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

  it('pins every builtin and known-blocked drift contract to its audit date', () => {
    // Goose 는 0.8.1 에서 provider 캐시 경로가 정정되며 재검증됐다 — 그 이전 문구는
    // 존재하지 않는 `~/.config/goose/providers/**` 를 스왑한다고 단정하는 라이브 오탐이었다.
    // 나머지는 2026-07-15 감사 기준을 유지한다.
    const REVERIFIED: Record<string, string> = { goose: '2026-07-26' };
    for (const cliId of [...BUILTIN_CLI_DEFS.map((def) => def.id), 'agy']) {
      const contracts = buildCliSupportReport(cliId).driftContracts;
      expect(contracts.length, `${cliId} must expose an audited drift contract`).toBeGreaterThan(0);
      expect(contracts.map((contract) => contract.lastVerified), cliId).toEqual(
        contracts.map(() => REVERIFIED[cliId] ?? '2026-07-15')
      );
    }
  });

  it('goose drift contract no longer claims the stale providers/ layout', () => {
    const contracts = buildCliSupportReport('goose').driftContracts;
    // summary/evidence 는 **현재 계약**이므로 구 레이아웃을 주장해선 안 된다.
    for (const contract of contracts) {
      expect(contract.summary).not.toContain('goose/providers');
      expect(contract.evidence.join('\n')).not.toContain('goose/providers');
    }
    expect(contracts.map(c => c.summary).join('\n')).toContain('beneath ~/.config/goose');
    // risks 는 반대로 구 경로를 **의도적으로 언급**해야 한다 — 0.8.1 이전 프로필은 provider
    // 아티팩트를 갖고 있지 않아 재스냅샷이 필요하다는 사실이 기계 판독 출력에도 남아야 한다.
    const risks = contracts.flatMap(c => c.risks ?? []).join('\n');
    expect(risks).toContain('goose/providers');
    // 복구 안내는 **순서 조건**을 반드시 포함해야 한다. "각 프로필을 재캡처하라" 만 적으면
    // switch UX 의 "지금 재캡처하지 마세요" 경고와 정면으로 모순되고, 그대로 따르는 사용자는
    // 직전 계정의 자격증명을 방금 전환한 프로필에 저장하게 된다.
    expect(risks).toMatch(/re-capture each profile while its own account is logged in/i);
    expect(risks).toMatch(/never re-capture right after a switch reported a carried-over artifact/i);
  });

  it('explains Crush freshness as supported conservative byte-diff with pin evidence', () => {
    const report = buildCliSupportReport('crush');
    const serialized = JSON.stringify(report);

    expect(BUILTIN_FRESHNESS_ADAPTER_IDS).toContain('crush');
    expect(report.capabilities.freshness.status).toBe('supported');
    expect(report.capabilities.freshness.summary).toMatch(/conservative byte-diff|identity/i);
    expect(report.capabilities.freshness.summary).not.toMatch(/static-key-only|static API key only/i);
    // Approved copy may say "not confirmed rotation"; forbid affirmative same-account claims.
    expect(report.capabilities.freshness.summary).not.toMatch(/\bsame account\b(?! continuity)/i);
    expect(report.capabilities.freshness.summary).toMatch(/not confirmed rotation|identity/i);
    expect(report.sources.map((s) => s.saveAs).sort()).toEqual([
      'crush-config.json',
      'crush-data.json'
    ]);
    expect(report.driftContracts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'crush-oauth-freshness',
          lastVerified: '2026-07-15',
          evidence: expect.arrayContaining([
            expect.stringMatching(/7b24cc09987337de8bdab1f8b78430efb00337b8/)
          ])
        })
      ])
    );
    expect(serialized).toMatch(/Hyper|Copilot|OAuth/i);
    expect(serialized).toMatch(/CRUSH_GLOBAL_|project-local|XDG/i);
    expect(serialized).not.toMatch(/Fallback byte-diff only; no adapter-backed/);
    expect(serialized).not.toContain('crushfake-access');
    expect(serialized).not.toContain('sk-fake-crush');
  });
});
