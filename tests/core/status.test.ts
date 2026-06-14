import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setActiveProfile } from '../../src/core/config.js';
import { auditLogPath, sessionDir } from '../../src/core/paths.js';
import { writeProfileFile } from '../../src/core/profile-store.js';
import { buildStatusReport, formatStatusReport } from '../../src/core/status.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('status report', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('reports active profiles and session summary without writing audit log', async () => {
    await writeProfileFile(
      'codex',
      'work',
      'auth.json',
      JSON.stringify({ tokens: { account_id: 'acct-person@example.test' }, auth_mode: 'ChatGPT' })
    );
    await setActiveProfile('codex', 'work');
    const dir = sessionDir('codex-work-status1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      join(dir, 'session.json'),
      JSON.stringify({
        id: 'codex-work-status1',
        cli: 'codex',
        profile: 'work',
        pid: process.pid,
        startedAt: '2026-06-14T00:00:00.000Z',
        roots: [{ env: 'CODEX_HOME', dir: join(tmp.home, 'secret-dir') }]
      })
    );

    const report = await buildStatusReport();

    expect(report.schemaVersion).toBe(1);
    expect(report.activeProfiles[0]).toMatchObject({
      cliId: 'codex',
      profileName: 'work',
      metadataIssue: 'missing'
    });
    expect(report.sessions).toEqual({ total: 1, active: 1, orphan: 0, unknown: 0 });
    expect(JSON.stringify(report)).not.toContain('secret-dir');
    expect(JSON.stringify(report)).not.toContain('acct-person@example.test');
    await expect(fs.stat(auditLogPath())).rejects.toMatchObject({ code: 'ENOENT' });

    const human = formatStatusReport(report);
    expect(human).toContain('codex: work');
    expect(human).toContain('identity: unavailable');
    expect(human).toContain('sessions: total=1 active=1 orphan=0 unknown=0');
  });

  it('surfaces normalized meta identity without echoing tampered metadata', async () => {
    const profileDir = join(tmp.home, '.multi-account-tool', 'profiles', 'codex', 'work');
    await fs.mkdir(profileDir, { recursive: true });
    await fs.writeFile(
      join(profileDir, 'meta.json'),
      JSON.stringify({
        name: 'work',
        cli: 'codex',
        createdAt: '2026-06-14T00:00:00.000Z',
        updatedAt: 'not-an-email@example.test',
        label: 'sk-abcdefghijklmnopqrstuvwxyz0123456789',
        identity: {
          schemaVersion: 1,
          status: 'available',
          capturedAt: '2026-06-14T00:00:00.000Z',
          completeness: 'complete',
          signals: [
            { kind: 'email', source: 'auth.json', confidence: 'high', value: 'raw@example.test' },
            { kind: 'account', source: '../../../secret', confidence: 'high', fingerprint: '<hash:123456789abc>' }
          ]
        }
      })
    );
    await setActiveProfile('codex', 'work');

    const report = await buildStatusReport();
    const out = JSON.stringify(report);

    expect(report.activeProfiles[0]).toMatchObject({ metadataIssue: 'invalid' });
    expect(out).toContain('<hash:123456789abc>');
    expect(out).not.toContain('raw@example.test');
    expect(out).not.toContain('not-an-email@example.test');
    expect(out).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(out).not.toContain('../../../secret');
  });
});
