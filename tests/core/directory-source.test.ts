import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  __setDirectorySourceFsOpsForTests,
  parseDirectorySnapshot,
  readDirectorySource,
  removeDirectorySource,
  writeDirectorySource
} from '../../src/core/directory-source.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';
import { __setBeforePinnedRemoveForTests } from '../../src/core/pinned-remove.js';

const source = (path: string) => ({ type: 'directory' as const, path, saveAs: 'tree.json', maxEntries: 16, maxBytes: 4096, maxDepth: 4 });

describe('DirectorySource', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { __setDirectorySourceFsOpsForTests(null); __setBeforePinnedRemoveForTests(null); await tmp.cleanup(); });

  it('captures deterministic topology including empty directories and restores bytes', async () => {
    const root = join(tmp.home, 'cache');
    await fs.mkdir(join(root, 'empty'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(root, 'token.bin'), Buffer.from([0, 1, 255]), { mode: 0o600 });
    const raw = await readDirectorySource(source(root));
    expect(raw).toContain('"empty"');
    await fs.rm(root, { recursive: true });
    await writeDirectorySource(source(root), raw!);
    expect(await fs.readFile(join(root, 'token.bin'))).toEqual(Buffer.from([0, 1, 255]));
    expect((await fs.stat(join(root, 'empty'))).isDirectory()).toBe(true);
  });

  it('sorts the complete captured tree globally so sibling prefixes round-trip through the codec', async () => {
    const root = join(tmp.home, 'cache');
    await fs.mkdir(join(root, 'a'), { recursive: true, mode: 0o700 });
    await fs.writeFile(join(root, 'a', 'z'), 'nested', { mode: 0o600 });
    await fs.writeFile(join(root, 'a-foo'), 'sibling', { mode: 0o600 });
    const raw = await readDirectorySource(source(root));
    expect(JSON.parse(raw!).entries.map((entry: { path: string }) => entry.path)).toEqual(['a', 'a-foo', 'a/z']);
    expect(() => parseDirectorySnapshot(raw!, source(root))).not.toThrow();
    await fs.rm(root, { recursive: true }); await writeDirectorySource(source(root), raw!);
    expect(await fs.readFile(join(root, 'a', 'z'), 'utf8')).toBe('nested');
    expect(await fs.readFile(join(root, 'a-foo'), 'utf8')).toBe('sibling');
  });

  it('treats a root beneath missing fixed ancestors as an ordinary absent source', async () => {
    const root = join(tmp.home, 'missing', 'ancestors', 'cache');
    await expect(readDirectorySource(source(root))).resolves.toBeNull();
    await expect(removeDirectorySource(source(root))).resolves.toBeUndefined();
  });

  it('fails closed for a symlink and malformed/path-traversal snapshots', async () => {
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    await fs.symlink('/tmp', join(root, 'escape'));
    await expect(readDirectorySource(source(root))).rejects.toThrow(/symlink/);
    expect(() => parseDirectorySnapshot('{"version":1,"entries":[{"kind":"file","path":"../x","contentBase64":""}]}', source(root))).toThrow(/relative path/);
  });

  it('recovers an unambiguous interrupted same-parent activation marker', async () => {
    const root = join(tmp.home, 'cache');
    const stage = join(tmp.home, '.cache.mat-stage-abcdef123456');
    const backup = join(tmp.home, '.cache.mat-backup-abcdef123456');
    await fs.mkdir(stage, { mode: 0o700 });
    await fs.writeFile(join(stage, 'new'), 'x', { mode: 0o600 });
    await fs.mkdir(backup, { mode: 0o700 });
    await fs.writeFile(join(backup, 'old'), 'x', { mode: 0o600 });
    const intended = JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'new', contentBase64: 'eA==' }] });
    await fs.writeFile(join(tmp.home, '.mat-directory-source-txn.json'), JSON.stringify({ version: 1, root: 'cache', stage: '.cache.mat-stage-abcdef123456', backup: '.cache.mat-backup-abcdef123456', intent: createHash('sha256').update(intended).digest('hex'), phase: 'backed-up' }), { mode: 0o600 });
    await expect(readDirectorySource(source(root))).resolves.toContain('new');
    await expect(fs.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(join(tmp.home, '.mat-directory-source-txn.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects noncanonical base64 and a file used as a parent', () => {
    expect(() => parseDirectorySnapshot('{"version":1,"entries":[{"kind":"file","path":"a","contentBase64":""},{"kind":"file","path":"a/b","contentBase64":""}]}', source(join(tmp.home, 'cache')))).toThrow(/parent/);
    expect(() => parseDirectorySnapshot('{"version":1,"entries":[{"kind":"file","path":"a","contentBase64":"YQ"}]}', source(join(tmp.home, 'cache')))).toThrow(/base64/);
  });

  it('rejects oversized/unknown/prototype/collision/order snapshot inputs before mutation', () => {
    const src = source(join(tmp.home, 'cache'));
    expect(() => parseDirectorySnapshot(JSON.stringify({ version: 1, entries: [], unexpected: true }), src)).toThrow(/schema/);
    expect(() => parseDirectorySnapshot('{"version":1,"entries":[{"kind":"file","path":"__proto__","contentBase64":""}]}', src)).toThrow(/relative/);
    expect(() => parseDirectorySnapshot('{"version":1,"entries":[{"kind":"file","path":"z","contentBase64":""},{"kind":"file","path":"a","contentBase64":""}]}', src)).toThrow(/order/);
    expect(() => parseDirectorySnapshot('{"version":1,"entries":[{"kind":"file","path":"a","contentBase64":""},{"kind":"file","path":"A","contentBase64":""}]}', src)).toThrow(/duplicate/);
    expect(() => parseDirectorySnapshot(JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'x', contentBase64: Buffer.alloc(4097).toString('base64') }] }), src)).toThrow(/encoded size|byte limit/);
  });

  it('refuses ambiguous recovery and retains marker and candidate evidence', async () => {
    const root = join(tmp.home, 'cache');
    const stage = join(tmp.home, '.cache.mat-stage-abcdef123456');
    const backup = join(tmp.home, '.cache.mat-backup-abcdef123456');
    await fs.mkdir(root, { mode: 0o700 }); await fs.writeFile(join(root, 'live'), 'x', { mode: 0o600 });
    await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(join(stage, 'new'), 'x', { mode: 0o600 });
    await fs.mkdir(backup, { mode: 0o700 }); await fs.writeFile(join(backup, 'old'), 'x', { mode: 0o600 });
    await fs.writeFile(join(tmp.home, '.mat-directory-source-txn.json'), JSON.stringify({ version: 1, root: 'cache', stage: '.cache.mat-stage-abcdef123456', backup: '.cache.mat-backup-abcdef123456', intent: '0'.repeat(64), phase: 'backed-up' }), { mode: 0o600 });
    await expect(readDirectorySource(source(root))).rejects.toThrow(/ambiguous/);
    await expect(fs.access(stage)).resolves.toBeUndefined();
    await expect(fs.access(backup)).resolves.toBeUndefined();
    await expect(fs.access(join(tmp.home, '.mat-directory-source-txn.json'))).resolves.toBeUndefined();
  });

  it('refuses a marker that names another root or leaves an extra same-root candidate', async () => {
    const root = join(tmp.home, 'cache');
    const stage = join(tmp.home, '.cache.mat-stage-abcdef123456');
    await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(join(stage, 'new'), 'x', { mode: 0o600 });
    await fs.mkdir(join(tmp.home, '.cache.mat-stage-fedcba654321'), { mode: 0o700 });
    const marker = { version: 1, root: 'cache', stage: '.other.mat-stage-abcdef123456', backup: '.cache.mat-backup-abcdef123456', intent: '0'.repeat(64), phase: 'prepared' };
    await fs.writeFile(join(tmp.home, '.mat-directory-source-txn.json'), JSON.stringify(marker), { mode: 0o600 });
    await expect(readDirectorySource(source(root))).rejects.toThrow(/invalid transaction marker/);
    await expect(fs.access(stage)).resolves.toBeUndefined();
  });

  it('refuses markerless stage or backup candidates rather than guessing recovery', async () => {
    const root = join(tmp.home, 'cache');
    const stage = join(tmp.home, '.cache.mat-stage-abcdef123456');
    await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(join(stage, 'x'), 'x', { mode: 0o600 });
    await expect(readDirectorySource(source(root))).rejects.toThrow(/orphan transaction candidates/);
    await expect(fs.access(stage)).resolves.toBeUndefined();
  });

  it('rejects hardlinked descendants and leaves the live tree untouched', async () => {
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    const outside = join(tmp.home, 'outside'); await fs.writeFile(outside, 'secret', { mode: 0o600 });
    await fs.link(outside, join(root, 'linked'));
    await expect(readDirectorySource(source(root))).rejects.toThrow(/hardlink/);
    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
  });

  it('rejects a FIFO descendant without opening it (portable Unix guard)', async () => {
    if (process.platform === 'win32') return;
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    const fifo = join(root, 'pipe');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    await expect(readDirectorySource(source(root))).rejects.toThrow(/special file/);
  });

  it('enforces exact codec boundaries for count, decoded bytes, depth, and serialized bytes', () => {
    const root = join(tmp.home, 'cache');
    const bounded = { ...source(root), maxEntries: 2, maxBytes: 2, maxDepth: 2 };
    const exact = JSON.stringify({ version: 1, entries: [
      { kind: 'dir', path: 'a' },
      { kind: 'file', path: 'a/b', contentBase64: Buffer.from('xy').toString('base64') }
    ] });
    expect(parseDirectorySnapshot(exact, bounded).entries).toHaveLength(2);
    expect(() => parseDirectorySnapshot(JSON.stringify({ version: 1, entries: [
      { kind: 'dir', path: 'a' }, { kind: 'file', path: 'a/b', contentBase64: 'eA==' }, { kind: 'file', path: 'z', contentBase64: '' }
    ] }), bounded)).toThrow(/entry limit/);
    expect(() => parseDirectorySnapshot(JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'x', contentBase64: Buffer.from('xyz').toString('base64') }] }), bounded)).toThrow(/encoded size|byte limit/);
    expect(() => parseDirectorySnapshot(JSON.stringify({ version: 1, entries: [
      { kind: 'dir', path: 'a' }, { kind: 'dir', path: 'a/b' }, { kind: 'file', path: 'a/b/c', contentBase64: '' }
    ] }), { ...bounded, maxEntries: 3 })).toThrow(/depth limit/);

    const minimal = JSON.stringify({ version: 1, entries: [] });
    const exactSerialized = minimal + ' '.repeat(2 * 1024 * 1024 - Buffer.byteLength(minimal));
    expect(parseDirectorySnapshot(exactSerialized, bounded)).toEqual({ version: 1, entries: [] });
    expect(() => parseDirectorySnapshot(`${exactSerialized} `, bounded)).toThrow(/serialized size/);
  });

  it('rejects malformed, unknown, prototype, normalization, collision, and ordering boundary inputs', () => {
    const src = source(join(tmp.home, 'cache'));
    const invalid = [
      '{',
      '[]',
      '{"version":2,"entries":[]}',
      '{"version":1,"entries":[{"kind":"dir","path":"a","prototype":true}]}',
      '{"version":1,"entries":[{"kind":"file","path":"constructor","contentBase64":""}]}',
      JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'e\u0301', contentBase64: '' }] }),
      '{"version":1,"entries":[{"kind":"file","path":"A","contentBase64":""},{"kind":"file","path":"a","contentBase64":""}]}',
      '{"version":1,"entries":[{"kind":"file","path":"b","contentBase64":""},{"kind":"file","path":"a","contentBase64":""}]}'
    ];
    for (const value of invalid) expect(() => parseDirectorySnapshot(value, src)).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('rejects an unreadable regular file where permissions are enforceable', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    const path = join(root, 'unreadable'); await fs.writeFile(path, 'opaque', { mode: 0o000 });
    await expect(readDirectorySource(source(root))).rejects.toThrow(/filesystem operation failed/);
  });

  it('recovers every valid prepared/backed-up/activated phase for prior-live present or absent', async () => {
    const root = join(tmp.home, 'cache');
    const marker = join(tmp.home, '.mat-directory-source-txn.json');
    const stage = join(tmp.home, '.cache.mat-stage-abcdef123456');
    const backup = join(tmp.home, '.cache.mat-backup-abcdef123456');
    const snapshot = (name: string, body: string) => JSON.stringify({ version: 1, entries: [{ kind: 'file', path: name, contentBase64: Buffer.from(body).toString('base64') }] });
    const writeTree = async (path: string, name: string, body: string) => { await fs.mkdir(path, { mode: 0o700 }); await fs.writeFile(join(path, name), body, { mode: 0o600 }); };
    const writeTxn = async (phase: 'prepared' | 'backed-up' | 'activated') => fs.writeFile(marker, JSON.stringify({
      version: 1, root: 'cache', stage: '.cache.mat-stage-abcdef123456', backup: '.cache.mat-backup-abcdef123456',
      intent: createHash('sha256').update(snapshot('new', 'new-bytes')).digest('hex'), phase
    }), { mode: 0o600 });
    const reset = async () => { await Promise.all([root, stage, backup, marker].map(path => fs.rm(path, { recursive: true, force: true }))); };

    await writeTree(root, 'old', 'old-bytes'); await writeTree(stage, 'new', 'new-bytes'); await writeTxn('prepared');
    expect(await readDirectorySource(source(root))).toBe(snapshot('old', 'old-bytes'));
    await expect(fs.access(stage)).rejects.toMatchObject({ code: 'ENOENT' });

    await reset(); await writeTree(stage, 'new', 'new-bytes'); await writeTxn('prepared');
    expect(await readDirectorySource(source(root))).toBe(snapshot('new', 'new-bytes'));

    await reset(); await writeTree(root, 'new', 'new-bytes'); await writeTxn('prepared');
    await expect(readDirectorySource(source(root))).resolves.toBeNull();

    await reset(); await writeTree(stage, 'new', 'new-bytes'); await writeTree(backup, 'old', 'old-bytes'); await writeTxn('backed-up');
    expect(await readDirectorySource(source(root))).toBe(snapshot('new', 'new-bytes'));
    await expect(fs.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });

    await reset(); await writeTree(root, 'new', 'new-bytes'); await writeTree(backup, 'old', 'old-bytes'); await writeTxn('activated');
    expect(await readDirectorySource(source(root))).toBe(snapshot('new', 'new-bytes'));
    await expect(fs.access(backup)).rejects.toMatchObject({ code: 'ENOENT' });

    await reset(); await writeTree(root, 'new', 'new-bytes'); await writeTxn('activated');
    expect(await readDirectorySource(source(root))).toBe(snapshot('new', 'new-bytes'));
    await expect(fs.access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed and retains evidence for an impossible backed-up phase without a prior-live backup', async () => {
    const root = join(tmp.home, 'cache');
    const stage = join(tmp.home, '.cache.mat-stage-abcdef123456');
    await fs.mkdir(stage, { mode: 0o700 }); await fs.writeFile(join(stage, 'new'), 'new', { mode: 0o600 });
    const intended = JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'new', contentBase64: Buffer.from('new').toString('base64') }] });
    const marker = join(tmp.home, '.mat-directory-source-txn.json');
    await fs.writeFile(marker, JSON.stringify({ version: 1, root: 'cache', stage: '.cache.mat-stage-abcdef123456', backup: '.cache.mat-backup-abcdef123456', intent: createHash('sha256').update(intended).digest('hex'), phase: 'backed-up' }), { mode: 0o600 });
    await expect(readDirectorySource(source(root))).rejects.toThrow(/ambiguous/);
    await expect(fs.access(stage)).resolves.toBeUndefined();
    await expect(fs.access(marker)).resolves.toBeUndefined();
  });

  it.each([true, false])('activation rename failure restores prior %s state and cleans transaction artifacts', async (priorPresent) => {
    const root = join(tmp.home, 'cache');
    if (priorPresent) { await fs.mkdir(root, { mode: 0o700 }); await fs.writeFile(join(root, 'old'), 'old-bytes', { mode: 0o600 }); }
    __setDirectorySourceFsOpsForTests({
      rename: async (from, to) => {
        if (String(from).includes('.mat-stage-') && to === root) throw Object.assign(new Error('injected activation path/credential'), { code: 'EIO' });
        return fs.rename(from, to);
      }
    } as Partial<typeof fs>);
    const value = JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'secret-descendant-name', contentBase64: Buffer.from('new-secret-bytes').toString('base64') }] });
    const error = await writeDirectorySource(source(root), value).catch(err => err as Error);
    expect(error.message).toMatch(priorPresent ? /prior live restored/ : /prior absence restored/);
    expect(error.message).not.toMatch(/secret-descendant-name|new-secret-bytes|credential|\/Users\//);
    if (priorPresent) expect(await fs.readFile(join(root, 'old'), 'utf8')).toBe('old-bytes');
    else await expect(fs.access(root)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await fs.readdir(tmp.home)).filter(name => name.includes('.mat-'))).toEqual([]);
  });

  it('retains marker, stage, and backup when activation and backup rollback both fail', async () => {
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 }); await fs.writeFile(join(root, 'old'), 'old', { mode: 0o600 });
    __setDirectorySourceFsOpsForTests({
      rename: async (from, to) => {
        if ((String(from).includes('.mat-stage-') || String(from).includes('.mat-backup-')) && to === root) throw Object.assign(new Error('credential-path'), { code: 'EIO' });
        return fs.rename(from, to);
      }
    } as Partial<typeof fs>);
    const value = JSON.stringify({ version: 1, entries: [{ kind: 'file', path: 'private-child', contentBase64: 'eA==' }] });
    const error = await writeDirectorySource(source(root), value).catch(err => err as Error);
    expect(error.message).toMatch(/activation failed; backup rollback failed/);
    expect(error.message).not.toMatch(/credential-path|private-child|\/Users\//);
    const names = await fs.readdir(tmp.home);
    expect(names).toContain('.mat-directory-source-txn.json');
    expect(names.some(name => name.includes('.mat-stage-'))).toBe(true);
    expect(names.some(name => name.includes('.mat-backup-'))).toBe(true);
  });

  it('fails closed on parent/root/descendant identity changes without reading or mutating outside targets', async () => {
    const outside = join(tmp.home, 'outside'); await fs.mkdir(outside, { mode: 0o700 });
    const outsideFile = join(outside, 'outside-target'); await fs.writeFile(outsideFile, 'outside-secret', { mode: 0o600 });

    const parent = join(tmp.home, 'provider'); const root = join(parent, 'cache');
    await fs.mkdir(root, { recursive: true, mode: 0o700 }); await fs.writeFile(join(root, 'inside'), 'inside', { mode: 0o600 });
    let parentStats = 0;
    __setDirectorySourceFsOpsForTests({ lstat: async (path, options) => {
      if (path === parent && ++parentStats === 2) { await fs.rename(parent, `${parent}.old`); await fs.symlink(outside, parent); }
      return fs.lstat(path, options as never);
    }} as Partial<typeof fs>);
    let error = await readDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toMatch(/symlink|identity changed/);
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside-secret');

    __setDirectorySourceFsOpsForTests(null);
    await fs.rm(parent, { force: true }); await fs.rename(`${parent}.old`, parent);
    let rootStats = 0;
    __setDirectorySourceFsOpsForTests({ lstat: async (path, options) => {
      if (path === root && ++rootStats === 2) { await fs.rename(root, `${root}.old`); await fs.symlink(outside, root); }
      return fs.lstat(path, options as never);
    }} as Partial<typeof fs>);
    error = await readDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toMatch(/symlink|identity changed/);
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside-secret');

    __setDirectorySourceFsOpsForTests(null);
    await fs.rm(root, { force: true }); await fs.rename(`${root}.old`, root);
    const inside = join(root, 'inside');
    __setDirectorySourceFsOpsForTests({ open: async (path, flags, mode) => {
      if (path === inside) { await fs.unlink(inside); await fs.symlink(outsideFile, inside); }
      return fs.open(path, flags, mode);
    }} as Partial<typeof fs>);
    error = await readDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toMatch(/filesystem operation failed|identity changed/);
    expect(error.message).not.toMatch(/inside|outside-target|outside-secret/);
    expect(await fs.readFile(outsideFile, 'utf8')).toBe('outside-secret');
  });

  it('fails closed for ENOENT/hardlink substitutions between validation and open, and never mutates the outside inode', async () => {
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    const inside = join(root, 'opaque-child'); await fs.writeFile(inside, 'inside', { mode: 0o600 });
    __setDirectorySourceFsOpsForTests({ open: async (path, flags, mode) => {
      if (path === inside) throw Object.assign(new Error(`ENOENT ${inside} credential-bytes`), { code: 'ENOENT' });
      return fs.open(path, flags, mode);
    }} as Partial<typeof fs>);
    let error = await readDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toBe('unsafe directory source: filesystem operation failed (ENOENT)');

    __setDirectorySourceFsOpsForTests(null);
    const outside = join(tmp.home, 'outside-file'); await fs.writeFile(outside, 'outside-secret', { mode: 0o600 });
    let substituted = false;
    __setDirectorySourceFsOpsForTests({ open: async (path, flags, mode) => {
      if (path === inside && !substituted) { substituted = true; await fs.unlink(inside); await fs.link(outside, inside); }
      return fs.open(path, flags, mode);
    }} as Partial<typeof fs>);
    error = await readDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toMatch(/identity changed|hardlink/);
    expect(error.message).not.toMatch(/opaque-child|outside-file|outside-secret/);
    expect(await fs.readFile(outside, 'utf8')).toBe('outside-secret');
  });

  it('an ENOENT between remove validation and unlink fails closed without pruning or outside mutation', async () => {
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    const child = join(root, 'sensitive-child'); await fs.writeFile(child, 'inside', { mode: 0o600 });
    const outside = join(tmp.home, 'outside'); await fs.writeFile(outside, 'outside-secret', { mode: 0o600 });
    __setBeforePinnedRemoveForTests(({ parent, name, kind }) => {
      if (parent === root && name === 'sensitive-child' && kind === 'file') throw Object.assign(new Error(`ENOENT ${child} outside-secret`), { code: 'ENOENT' });
    });
    const error = await removeDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toBe('unsafe directory source: filesystem operation failed (ENOENT)');
    expect(await fs.readFile(child, 'utf8')).toBe('inside');
    expect(await fs.readFile(outside, 'utf8')).toBe('outside-secret');
  });

  it('pins the removal parent inode so an ancestor swap cannot delete an outside descendant', async () => {
    const root = join(tmp.home, 'cache'); await fs.mkdir(root, { mode: 0o700 });
    const child = join(root, 'same-name'); await fs.writeFile(child, 'inside', { mode: 0o600 });
    const outside = join(tmp.home, 'outside-dir'); await fs.mkdir(outside, { mode: 0o700 });
    const outsideChild = join(outside, 'same-name'); await fs.writeFile(outsideChild, 'outside-secret', { mode: 0o600 });
    let swapped = false;
    __setBeforePinnedRemoveForTests(async ({ parent, name, kind }) => {
      if (!swapped && parent === root && name === 'same-name' && kind === 'file') {
        swapped = true; await fs.rename(root, `${root}.old`); await fs.symlink(outside, root);
      }
    });
    const error = await removeDirectorySource(source(root)).catch(err => err as Error);
    expect(error.message).toMatch(/filesystem operation failed/);
    expect(error.message).not.toMatch(/same-name|outside-secret|outside-dir/);
    expect(await fs.readFile(outsideChild, 'utf8')).toBe('outside-secret');
    expect(await fs.readFile(join(`${root}.old`, 'same-name'), 'utf8')).toBe('inside');
  });
});
