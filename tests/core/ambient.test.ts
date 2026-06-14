import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { detectAmbientWarnings, formatAmbientWarnings } from '../../src/core/ambient.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('ambient warnings — shared detector', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('detects env names without including env values', async () => {
    const warnings = await detectAmbientWarnings('codex', {
      cwd: tmp.home,
      env: { OPENAI_API_KEY: 'sk-secret-value-must-not-appear' }
    });
    const serialized = JSON.stringify(warnings);

    expect(warnings.map((w) => w.code)).toContain('ambient.env');
    expect(serialized).toContain('OPENAI_API_KEY');
    expect(serialized).not.toContain('sk-secret-value-must-not-appear');
  });

  it('detects env prefixes and redacts long env names', async () => {
    const longKey = 'AIDER_abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz';
    const warnings = await detectAmbientWarnings('aider', {
      cwd: tmp.home,
      env: { [longKey]: 'present' }
    });

    expect(JSON.stringify(warnings)).not.toContain('abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz');
    expect(warnings[0].code).toBe('ambient.env');
  });

  it('checks cwd entries by metadata only and reports symlink kind', async () => {
    const secretTarget = join(tmp.home, 'secret-target');
    await fs.writeFile(secretTarget, 'secret-file-content-must-not-appear');
    await fs.symlink(secretTarget, join(tmp.home, '.env'));

    const warnings = await detectAmbientWarnings('aider', { cwd: tmp.home, env: {} });
    const serialized = JSON.stringify(warnings);

    expect(serialized).toContain('.env');
    expect(serialized).toContain('symlink');
    expect(serialized).not.toContain('secret-file-content-must-not-appear');
  });

  it('returns no warnings for unknown CLIs', async () => {
    await expect(detectAmbientWarnings('unknown', { cwd: tmp.home, env: { OPENAI_API_KEY: 'x' } })).resolves.toEqual([]);
  });

  it('does not throw when the current working directory cannot be resolved', async () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockImplementation(() => {
      throw new Error('cwd unavailable');
    });

    try {
      const warnings = await detectAmbientWarnings('aider', {
        env: { AIDER_MODEL: 'secret-value-must-not-appear' }
      });
      const serialized = JSON.stringify(warnings);

      expect(warnings.map((w) => w.code)).toContain('ambient.env');
      expect(warnings.map((w) => w.code)).toContain('ambient.cwd.unreadable');
      expect(serialized).toContain('AIDER_MODEL');
      expect(serialized).not.toContain('secret-value-must-not-appear');
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it('formats a warning-only block', async () => {
    const warnings = await detectAmbientWarnings('codex', {
      cwd: tmp.home,
      env: { CODEX_HOME: '/tmp/codex' }
    });
    const text = formatAmbientWarnings(warnings, { header: 'Header' });

    expect(text).toMatch(/Header/);
    expect(text).toMatch(/CODEX_HOME/);
    expect(text).toMatch(/continues/);
  });
});
