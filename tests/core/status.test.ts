import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { setActiveProfile } from '../../src/core/config.js';
import { auditLogPath, sessionDir } from '../../src/core/paths.js';
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
    expect(report.activeProfiles).toEqual([{ cliId: 'codex', profileName: 'work' }]);
    expect(report.sessions).toEqual({ total: 1, active: 1, orphan: 0, unknown: 0 });
    expect(JSON.stringify(report)).not.toContain('secret-dir');
    await expect(fs.stat(auditLogPath())).rejects.toMatchObject({ code: 'ENOENT' });

    const human = formatStatusReport(report);
    expect(human).toContain('codex: work');
    expect(human).toContain('sessions: total=1 active=1 orphan=0 unknown=0');
  });
});
