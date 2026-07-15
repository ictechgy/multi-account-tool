import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { BUILTIN_CLI_DEFS } from '../../src/core/cli-defs.js';
import { readSource, writeSource } from '../../src/core/sources.js';
import { expandTilde } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('Goose v1.43 provider caches — temporary HOME integration', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  it('round-trips each of the fixed five files and two bounded directories without touching a real HOME', async () => {
    const sources = BUILTIN_CLI_DEFS.find(def => def.id === 'goose')!.sources.filter(src => src.saveAs.startsWith('goose-provider-'));
    expect(sources).toHaveLength(7);
    for (const src of sources) {
      const opaque = src.type === 'directory'
        ? JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'cache.json', contentBase64: Buffer.from('opaque').toString('base64') }] })
        : 'opaque';
      await writeSource(src, opaque);
      expect(await readSource(src)).toBe(opaque);
      expect(expandTilde(src.path).startsWith(tmp.home)).toBe(true);
    }
    expect(await fs.readdir(join(tmp.home, '.config/goose/providers'))).toHaveLength(7);
  });

  it('captures and restores all seven provider artifacts through the public profile transaction under a temporary HOME', async () => {
    const previous = process.env.GOOSE_DISABLE_KEYRING;
    process.env.GOOSE_DISABLE_KEYRING = '1';
    vi.resetModules();
    try {
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const { writeSource: write, readSource: read } = await import('../../src/core/sources.js');
      const { snapshotLiveToProfile, restoreProfileToLive } = await import('../../src/core/switcher.js');
      const sources = defs.find(def => def.id === 'goose')!.sources;
      expect(sources).toHaveLength(9); // two YAML + seven fixed provider artifacts; no keyring.
      const encoded = (value: string) => Buffer.from(value).toString('base64');
      const valueFor = (tag: string, src: typeof sources[number]) => src.type === 'directory'
        ? JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'cache.json', contentBase64: encoded(`${tag}:${src.saveAs}`) }, { kind: 'dir', path: 'empty' }] })
        : `${tag}:${src.saveAs}`;
      for (const src of sources) await write(src, valueFor('alpha', src));
      await snapshotLiveToProfile('goose', 'alpha');
      for (const src of sources) await write(src, valueFor('beta', src));
      await snapshotLiveToProfile('goose', 'beta');
      await restoreProfileToLive('goose', 'alpha');
      await Promise.all(sources.map(async src => expect(await read(src)).toBe(valueFor('alpha', src))));
      await restoreProfileToLive('goose', 'beta');
      await Promise.all(sources.map(async src => expect(await read(src)).toBe(valueFor('beta', src))));
    } finally {
      if (previous === undefined) delete process.env.GOOSE_DISABLE_KEYRING;
      else process.env.GOOSE_DISABLE_KEYRING = previous;
      vi.resetModules();
    }
  });

  it('smokes the built CLI under a temporary file-backend HOME without exposing cache bytes', () => {
    const env = { ...process.env, HOME: tmp.home, GOOSE_DISABLE_KEYRING: '1' };
    for (const args of [['support', 'goose', '--json'], ['doctor', '--json']]) {
      const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain('goose');
      expect(result.stdout).not.toMatch(/eyJ[a-zA-Z0-9_-]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/);
    }
  });

  it.each([false, true])('real provider-file restore rolls an earlier absent source back to absence (rollback failure=%s)', async (failRollback) => {
    const previous = process.env.GOOSE_DISABLE_KEYRING; process.env.GOOSE_DISABLE_KEYRING = '1'; vi.resetModules();
    try {
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const { createProfile, writeProfileFile } = await import('../../src/core/profile-store.js');
      const { expandTilde: expand } = await import('../../src/core/paths.js');
      const sourcesModule = await import('../../src/core/sources.js');
      const pinnedWriteModule = await import('../../src/core/pinned-write.js');
      const pinnedModule = await import('../../src/core/pinned-remove.js');
      const { restoreProfileToLive } = await import('../../src/core/switcher.js');
      const providers = defs.find(def => def.id === 'goose')!.sources.filter(src => src.type === 'file' && src.saveAs.startsWith('goose-provider-'));
      const [first, second] = providers;
      await createProfile('goose', `file-rollback-${failRollback}`);
      await writeProfileFile('goose', `file-rollback-${failRollback}`, first.saveAs, 'first-credential-bytes');
      await writeProfileFile('goose', `file-rollback-${failRollback}`, second.saveAs, 'second-credential-bytes');
      const firstPath = expand(first.path); const secondPath = expand(second.path);
      pinnedWriteModule.__setPinnedWriteTestHooksForTests({
        faultStage: ({ parent, name }) => join(parent, name) === secondPath ? 'before-rename' : undefined
      });
      if (failRollback) pinnedModule.__setBeforePinnedRemoveForTests(({ parent, name, kind }) => {
        if (parent === dirname(firstPath) && name === basename(firstPath) && kind === 'file') throw Object.assign(new Error(`rollback ${firstPath} first-credential-bytes`), { code: 'EACCES' });
      });
      const error = await restoreProfileToLive('goose', `file-rollback-${failRollback}`).catch(err => err as Error);
      expect(error.message).toMatch(failRollback ? /restore failed; rollback also failed/ : /filesystem operation failed/);
      expect(error.message).not.toMatch(/first-credential-bytes|second-credential-bytes|gemini_oauth|chatgpt_codex|tokens\.json|\/Users\//);
      if (failRollback) expect(await fs.readFile(firstPath, 'utf8')).toBe('first-credential-bytes');
      else await expect(fs.access(firstPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(secondPath)).rejects.toMatchObject({ code: 'ENOENT' });
      sourcesModule.__setSourceFsOpsForTests(null);
      pinnedWriteModule.__setPinnedWriteTestHooksForTests(null);
      pinnedModule.__setBeforePinnedRemoveForTests(null);
    } finally {
      if (previous === undefined) delete process.env.GOOSE_DISABLE_KEYRING; else process.env.GOOSE_DISABLE_KEYRING = previous;
      vi.resetModules();
    }
  });

  it('real provider-file restore rolls the currently failing source back to absence after post-activation verification fails', async () => {
    const previous = process.env.GOOSE_DISABLE_KEYRING; process.env.GOOSE_DISABLE_KEYRING = '1'; vi.resetModules();
    try {
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const { createProfile, writeProfileFile } = await import('../../src/core/profile-store.js');
      const { expandTilde: expand } = await import('../../src/core/paths.js');
      const sourcesModule = await import('../../src/core/sources.js');
      const pinnedWriteModule = await import('../../src/core/pinned-write.js');
      const { restoreProfileToLive } = await import('../../src/core/switcher.js');
      const src = defs.find(def => def.id === 'goose')!.sources.find(item => item.saveAs === 'goose-provider-gemini-oauth-tokens.json')!;
      if (src.type !== 'file') throw new Error('fixture source type changed');
      await createProfile('goose', 'post-activation-failure');
      await writeProfileFile('goose', 'post-activation-failure', src.saveAs, 'post-activation-credential');
      const target = expand(src.path); let failed = false;
      pinnedWriteModule.__setPinnedWriteTestHooksForTests({
        faultStage: ({ parent, name }) => {
          if (join(parent, name) !== target) return undefined;
          failed = true;
          return 'after-rename';
        }
      });
      const error = await restoreProfileToLive('goose', 'post-activation-failure').catch(err => err as Error);
      expect(failed).toBe(true);
      expect(error.message).toMatch(/filesystem operation failed/);
      expect(error.message).not.toMatch(/post-activation-credential|gemini_oauth|tokens\.json|\/Users\//);
      await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
      sourcesModule.__setSourceFsOpsForTests(null);
      pinnedWriteModule.__setPinnedWriteTestHooksForTests(null);
    } finally {
      if (previous === undefined) delete process.env.GOOSE_DISABLE_KEYRING; else process.env.GOOSE_DISABLE_KEYRING = previous;
      vi.resetModules();
    }
  });

  it.each([false, true])('real provider-directory restore rolls an earlier absent tree back to absence (rollback failure=%s)', async (failRollback) => {
    const previous = process.env.GOOSE_DISABLE_KEYRING; process.env.GOOSE_DISABLE_KEYRING = '1'; vi.resetModules();
    try {
      const { BUILTIN_CLI_DEFS: defs } = await import('../../src/core/cli-defs.js');
      const { createProfile, writeProfileFile } = await import('../../src/core/profile-store.js');
      const { expandTilde: expand } = await import('../../src/core/paths.js');
      const directoryModule = await import('../../src/core/directory-source.js');
      const pinnedModule = await import('../../src/core/pinned-remove.js');
      const { restoreProfileToLive } = await import('../../src/core/switcher.js');
      const directories = defs.find(def => def.id === 'goose')!.sources.filter(src => src.type === 'directory');
      const [first, second] = directories;
      const profile = `directory-rollback-${failRollback}`; await createProfile('goose', profile);
      const value = (secret: string, descendant: string) => JSON.stringify({ version: 1, entries: [{ kind: 'file', path: descendant, contentBase64: Buffer.from(secret).toString('base64') }] });
      await writeProfileFile('goose', profile, first.saveAs, value('first-directory-credential', 'private-first-name'));
      await writeProfileFile('goose', profile, second.saveAs, value('second-directory-credential', 'private-second-name'));
      const firstRoot = expand(first.path); const secondRoot = expand(second.path);
      directoryModule.__setDirectorySourceFsOpsForTests({
        rename: async (from, to) => {
          if (to === secondRoot && String(from).includes('.mat-stage-')) throw Object.assign(new Error(`primary ${secondRoot} private-second-name`), { code: 'EIO' });
          return fs.rename(from, to);
        }
      } as Partial<typeof fs>);
      if (failRollback) pinnedModule.__setBeforePinnedRemoveForTests(({ parent, name, kind }) => {
        if (parent === dirname(firstRoot) && name === basename(firstRoot) && kind === 'directory') throw Object.assign(new Error(`rollback ${firstRoot} private-first-name`), { code: 'EACCES' });
      });
      const error = await restoreProfileToLive('goose', profile).catch(err => err as Error);
      expect(error.message).toMatch(failRollback ? /restore failed; rollback also failed/ : /activation failed; prior absence restored/);
      expect(error.message).not.toMatch(/first-directory-credential|second-directory-credential|private-first-name|private-second-name|githubcopilot|databricks|\/Users\//);
      if (failRollback) expect((await fs.stat(firstRoot)).isDirectory()).toBe(true);
      else await expect(fs.access(firstRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.access(secondRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      directoryModule.__setDirectorySourceFsOpsForTests(null);
      pinnedModule.__setBeforePinnedRemoveForTests(null);
    } finally {
      if (previous === undefined) delete process.env.GOOSE_DISABLE_KEYRING; else process.env.GOOSE_DISABLE_KEYRING = previous;
      vi.resetModules();
    }
  });

  it('support/doctor output and aggregated failures omit opaque cache bytes and descendant names', async () => {
    const root = join(tmp.home, '.config/goose/providers/githubcopilot');
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const descendant = 'customer-private-descendant.json'; const secret = 'credential-opaque-abcdefghijklmnopqrstuvwxyz';
    await fs.writeFile(join(root, descendant), secret, { mode: 0o600 });
    const env = { ...process.env, HOME: tmp.home, GOOSE_DISABLE_KEYRING: '1' };
    for (const args of [['support', 'goose', '--json'], ['doctor', '--json']]) {
      const result = spawnSync(process.execPath, ['dist/cli.js', ...args], { cwd: process.cwd(), env, encoding: 'utf8' });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).not.toContain(descendant);
      expect(output).not.toContain(secret);
    }
  });
});
