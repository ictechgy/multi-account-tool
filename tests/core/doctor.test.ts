import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';
import type { CliDef } from '../../src/core/types.js';

const mocks = vi.hoisted(() => ({
  getAllCliDefs: vi.fn<() => CliDef[]>(),
  getCliDefsWarnings: vi.fn<() => string[]>(),
  loadConfig: vi.fn(),
  listProfiles: vi.fn(),
  profileExists: vi.fn(),
  sourceExists: vi.fn()
}));

vi.mock('../../src/core/cli-defs.js', () => ({
  BUILTIN_CLI_DEFS: [
    {
      id: 'codex',
      name: 'Codex CLI',
      sources: [{ type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }],
      session: { roots: [{ env: 'CODEX_HOME', base: '~/.codex' }] },
      sessionRun: { executable: 'codex' }
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      sources: [{ type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' }],
      session: { roots: [{ env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini' }] },
      sessionRun: { executable: 'gemini' }
    },
    {
      id: 'claude',
      name: 'Claude Code',
      sources: [{ type: 'keychain', service: 'Claude Code-credentials', saveAs: 'credentials.json' }],
      sessionRun: { executable: 'claude' }
    },
    {
      id: 'aider',
      name: 'Aider',
      sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }],
      sessionRun: { executable: 'aider' }
    }
  ],
  getAllCliDefs: mocks.getAllCliDefs,
  getCliDefsWarnings: mocks.getCliDefsWarnings
}));

vi.mock('../../src/core/config.js', () => ({
  loadConfig: mocks.loadConfig
}));

vi.mock('../../src/core/profile-store.js', () => ({
  listProfiles: mocks.listProfiles,
  profileExists: mocks.profileExists
}));

vi.mock('../../src/core/sources.js', () => ({
  sourceExists: mocks.sourceExists
}));

const { runDoctor, formatDoctorReport } = await import('../../src/core/doctor.js');

describe('doctor — read-only safety report', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
    mocks.getCliDefsWarnings.mockReturnValue([]);
    mocks.loadConfig.mockResolvedValue({ version: 1, active: {} });
    mocks.listProfiles.mockResolvedValue([]);
    mocks.profileExists.mockResolvedValue(false);
    mocks.sourceExists.mockResolvedValue(false);
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('reports profile/source/session metadata without reading credential values', async () => {
    const liveDir = join(tmp.home, '.codex');
    await fs.mkdir(liveDir, { recursive: true });
    await fs.writeFile(join(liveDir, 'auth.json'), 'access_token=sk-should-not-appear');
    mocks.getAllCliDefs.mockReturnValue([
      {
        id: 'codex',
        name: 'Codex CLI',
        sources: [{ type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }],
        session: { roots: [{ env: 'CODEX_HOME', base: '~/.codex' }] },
        sessionRun: { executable: 'codex' }
      }
    ]);
    mocks.loadConfig.mockResolvedValue({ version: 1, active: { codex: 'work' } });
    mocks.listProfiles.mockResolvedValue(['work']);
    mocks.profileExists.mockResolvedValue(true);

    const report = await runDoctor({ cwd: tmp.home, env: {}, now: new Date('2026-06-14T00:00:00Z') });

    expect(report.schemaVersion).toBe(1);
    expect(report.clis[0].activeProfile).toBe('work');
    expect(report.clis[0].activeProfileExists).toBe(true);
    expect(report.clis[0].sources[0]).toMatchObject({ saveAs: 'auth.json', type: 'file', status: 'present' });
    expect(report.clis[0].freshness.status).toBe('not-run');
    expect(report.clis[0].session).toEqual({ start: 'supported', run: 'supported' });
    expect(JSON.stringify(report)).not.toContain('sk-should-not-appear');
    expect(mocks.sourceExists).not.toHaveBeenCalled();
  });

  it('warns about missing active profile and ambient override channels without env values', async () => {
    mocks.getAllCliDefs.mockReturnValue([
      { id: 'gemini', name: 'Gemini CLI', sources: [{ type: 'file', path: '~/.gemini/oauth_creds.json', saveAs: 'oauth_creds.json' }] }
    ]);
    mocks.loadConfig.mockResolvedValue({ version: 1, active: { gemini: 'personal' } });
    mocks.profileExists.mockResolvedValue(false);

    const report = await runDoctor({
      cwd: tmp.home,
      env: { GEMINI_API_KEY: 'sk-super-secret-value-that-must-not-appear' },
      now: new Date('2026-06-14T00:00:00Z')
    });

    expect(report.summary.status).toBe('warning');
    expect(report.clis[0].issues.map((i) => i.code)).toEqual(expect.arrayContaining(['active.profile-missing', 'ambient.env']));
    const serialized = JSON.stringify(report);
    expect(serialized).toContain('GEMINI_API_KEY');
    expect(serialized).not.toContain('sk-super-secret-value-that-must-not-appear');
  });

  it('checks cwd override files by metadata only and reports symlinks without reading target contents', async () => {
    const secretTarget = join(tmp.home, 'secret-target');
    await fs.writeFile(secretTarget, 'sk-file-content-must-not-appear');
    await fs.symlink(secretTarget, join(tmp.home, '.env'));
    mocks.getAllCliDefs.mockReturnValue([
      { id: 'aider', name: 'Aider', sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }] }
    ]);

    const report = await runDoctor({ cwd: tmp.home, env: {}, now: new Date('2026-06-14T00:00:00Z') });
    const serialized = JSON.stringify(report);

    expect(serialized).toContain('.env (symlink)');
    expect(serialized).not.toContain('sk-file-content-must-not-appear');
    expect(report.clis[0].issues.map((i) => i.code)).toContain('ambient.cwd');
  });

  it('keeps doctor JSON generation alive when process.cwd cannot be resolved', async () => {
    mocks.getAllCliDefs.mockReturnValue([
      { id: 'aider', name: 'Aider', sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }] }
    ]);
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd unavailable');
    });

    try {
      const report = await runDoctor({ env: {}, now: new Date('2026-06-14T00:00:00Z') });

      expect(report.summary.status).toBe('warning');
      expect(report.clis[0].issues.map((i) => i.code)).toContain('ambient.cwd.unreadable');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('captures keychain source failures as report data and redacts warning text', async () => {
    const secretLikeProfile = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    mocks.getAllCliDefs.mockReturnValue([
      { id: 'claude', name: 'Claude Code', sources: [{ type: 'keychain', service: 'Claude Code-credentials', saveAs: 'credentials.json' }] },
      { id: 'aider', name: 'Aider', sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }] }
    ]);
    mocks.loadConfig.mockResolvedValue({ version: 1, active: { claude: secretLikeProfile } });
    mocks.profileExists.mockResolvedValue(false);
    mocks.getCliDefsWarnings.mockReturnValue(['plugin warning contains sk-abcdefghijklmnopqrstuvwxyz0123456789']);
    mocks.sourceExists.mockRejectedValue(new Error('keychain failed with token=sk-abcdefghijklmnopqrstuvwxyz0123456789'));

    const report = await runDoctor({
      cwd: tmp.home,
      env: { AIDER_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz: 'present' },
      now: new Date('2026-06-14T00:00:00Z')
    });
    const serialized = JSON.stringify(report);

    expect(report.clis[0].sources[0].status).toBe('error');
    expect(report.clis[0].issues.map((i) => i.code)).toContain('source.error');
    expect(report.pluginWarnings[0]).toContain('[redacted]');
    expect(report.clis[0].activeProfile).toContain('[redacted]');
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz');
  });

  it('captures config load failures as report data instead of aborting JSON generation', async () => {
    mocks.getAllCliDefs.mockReturnValue([
      { id: 'codex', name: 'Codex CLI', sources: [{ type: 'file', path: '~/.codex/auth.json', saveAs: 'auth.json' }] }
    ]);
    mocks.loadConfig.mockRejectedValue(new Error('config parse failed with token=sk-abcdefghijklmnopqrstuvwxyz0123456789'));

    const report = await runDoctor({ cwd: tmp.home, env: {}, now: new Date('2026-06-14T00:00:00Z') });
    const configCheck = report.checks.find((c) => c.id === 'config');
    const serialized = JSON.stringify(report);

    expect(report.summary.status).toBe('error');
    expect(configCheck).toMatchObject({ status: 'error' });
    expect(serialized).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('formats a concise human report', async () => {
    mocks.getAllCliDefs.mockReturnValue([
      { id: 'aider', name: 'Aider', sources: [{ type: 'file', path: '~/.aider.conf.yml', saveAs: 'aider.yml' }] }
    ]);
    const report = await runDoctor({ cwd: tmp.home, env: { AIDER_MODEL: 'sonnet' }, now: new Date('2026-06-14T00:00:00Z') });

    const text = formatDoctorReport(report);
    expect(text).toMatch(/mat doctor/);
    expect(text).toMatch(/aider/);
    expect(text).toMatch(/AIDER_MODEL/);
  });
});
