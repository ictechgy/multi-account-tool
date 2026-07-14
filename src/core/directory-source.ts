/** Bounded, no-follow directory source codec and crash-safe activation helpers. */
import { createHash, randomBytes } from 'node:crypto';
import { constants, promises as realFs } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import type { DirectorySource } from './types.js';
import { expandTilde } from './paths.js';
import { removePinnedChild } from './pinned-remove.js';

type Entry = { kind: 'dir'; path: string } | { kind: 'file'; path: string; contentBase64: string };
interface Snapshot { version: 1; entries: Entry[]; }
interface Identity { path: string; dev: number; ino: number; }
interface TxnMarker {
  version: 1; root: string; stage: string; backup: string;
  intent: string; phase: 'prepared' | 'backed-up' | 'activated';
}

const MAX_SERIALIZED_BYTES = 2 * 1024 * 1024;
const DANGEROUS = new Set(['__proto__', 'constructor', 'prototype']);
const MARKER = '.mat-directory-source-txn.json';
const STAGING_NAME = /^\.[A-Za-z0-9._-]+\.mat-(?:stage|backup)-[0-9a-f]{12}$/;

type DirectorySourceFsOps = typeof realFs;
let fs: DirectorySourceFsOps = realFs;

/** Deterministic fault/race injection seam. Tests must restore with `null`. */
export function __setDirectorySourceFsOpsForTests(overrides: Partial<DirectorySourceFsOps> | null): void {
  fs = overrides ? Object.assign(Object.create(realFs) as DirectorySourceFsOps, overrides) : realFs;
}

function fail(message: string): never { throw new Error(`unsafe directory source: ${message}`); }
function publicError(err: unknown): Error {
  if (err instanceof Error && err.message.startsWith('unsafe directory source:')) return err;
  const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? ` (${err.code})` : '';
  return new Error(`unsafe directory source: filesystem operation failed${code}`);
}
function own(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function privateDir(st: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return st.isDirectory() && st.uid === process.getuid?.() && (Number(st.mode) & 0o022) === 0;
}
function same(st: Awaited<ReturnType<typeof fs.lstat>>, expected: Identity): boolean {
  return !st.isSymbolicLink() && Number(st.dev) === expected.dev && Number(st.ino) === expected.ino;
}
function safeRelative(value: unknown, maxDepth: number): string {
  if (typeof value !== 'string' || !value || value.startsWith('/') || value.includes('\\') || value === '.' || value.includes('//')) fail('invalid relative path');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.normalize('NFC') !== part || DANGEROUS.has(part))) fail('invalid relative path');
  if (parts.length > maxDepth) fail('depth limit');
  return value;
}
async function lstatRequired(path: string) {
  const st = await fs.lstat(path);
  if (st.isSymbolicLink()) fail('symlink');
  return st;
}
async function pathExists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
}

/** Review every HOME-to-parent component and retain identities for immediate rechecks. */
async function reviewParents(path: string, createMissing: boolean): Promise<Identity[]> {
  const home = process.env.HOME;
  const parent = dirname(path);
  if (!home || (parent !== home && !parent.startsWith(home + sep))) fail('root outside HOME');
  const parts = parent === home ? [] : relative(home, parent).split(sep);
  const result: Identity[] = [];
  let current = home;
  for (const part of ['.', ...parts]) {
    if (part !== '.') current = join(current, part);
    try {
      const st = await lstatRequired(current);
      if (!privateDir(st)) fail('unsafe parent');
      result.push({ path: current, dev: Number(st.dev), ino: Number(st.ino) });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || !createMissing || part === '.') throw err;
      await assertParents(result);
      await fs.mkdir(current, { mode: 0o700 });
      const st = await lstatRequired(current);
      if (!privateDir(st)) fail('created unsafe parent');
      result.push({ path: current, dev: Number(st.dev), ino: Number(st.ino) });
      await assertParents(result);
    }
  }
  return result;
}
async function assertParents(expected: Identity[]): Promise<void> {
  for (const item of expected) {
    const st = await lstatRequired(item.path);
    if (!privateDir(st) || !same(st, item)) fail('parent identity changed');
  }
}
/** Persist same-directory rename/unlink ordering; refusal is safer than a non-durable credential swap. */
async function syncDirectory(path: string): Promise<void> {
  const proof = await reviewParents(join(path, '.sync'), false);
  await assertParents(proof);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
  await assertParents(proof);
}

async function checkedRead(path: string, parents?: Identity[]): Promise<Buffer> {
  const expected = parents ?? await reviewParents(path, false);
  await assertParents(expected);
  const before = await lstatRequired(path);
  if (!before.isFile() || before.nlink !== 1) fail('non-regular or hardlinked file');
  await assertParents(expected);
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || Number(opened.dev) !== Number(before.dev) || Number(opened.ino) !== Number(before.ino)) fail('file identity changed');
    await assertParents(expected);
    const value = await handle.readFile();
    await assertParents(expected);
    const after = await lstatRequired(path);
    if (Number(after.dev) !== Number(before.dev) || Number(after.ino) !== Number(before.ino) || !after.isFile() || after.nlink !== 1) fail('file identity changed');
    return value;
  } finally { await handle.close(); }
}

/** Create a regular private file through O_EXCL|O_NOFOLLOW and verify activation. */
async function writePrivateFile(path: string, value: Buffer, parents?: Identity[]): Promise<void> {
  const expected = parents ?? await reviewParents(path, false);
  await assertParents(expected);
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.mat-write-${randomBytes(6).toString('hex')}`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await assertParents(expected);
    await handle.writeFile(value);
    await handle.sync();
    const tempSt = await handle.stat();
    if (!tempSt.isFile() || tempSt.nlink !== 1) fail('unsafe temporary file');
  } finally { await handle?.close(); }
  try {
    await assertParents(expected);
    const old = await fs.lstat(path).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
    if (old && (old.isSymbolicLink() || !old.isFile() || old.nlink !== 1)) fail('unsafe existing file');
    await fs.rename(temp, path);
    await syncDirectory(parent);
    await assertParents(expected);
    await checkedRead(path, expected);
  } catch (err) {
    const tempSt = await fs.lstat(temp).catch(() => null);
    if (tempSt?.isFile() && tempSt.nlink === 1) await fs.unlink(temp).catch(() => undefined);
    throw err;
  }
}

/** Validate and, when requested, serialize the complete tree using every read-time policy. */
async function captureTree(src: DirectorySource, root: string): Promise<Snapshot> {
  const rootParents = await reviewParents(root, false);
  await assertParents(rootParents);
  const rootSt = await lstatRequired(root);
  if (!privateDir(rootSt)) fail('unsafe root');
  const entries: Entry[] = [];
  let total = 0;
  let bytes = 0;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    const parents = await reviewParents(dir, false);
    await assertParents(parents);
    const before = await lstatRequired(dir);
    if (!privateDir(before)) fail('unsafe directory');
    const names = (await fs.readdir(dir)).sort();
    await assertParents(parents);
    const siblingNames = new Set<string>();
    for (const name of names) {
      const folded = name.normalize('NFC').toLocaleLowerCase('en-US');
      if (name.normalize('NFC') !== name || DANGEROUS.has(name) || siblingNames.has(folded)) fail('unsafe entry name');
      siblingNames.add(folded);
      const full = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      await assertParents(parents);
      const st = await lstatRequired(full);
      if (++total > src.maxEntries) fail('entry limit');
      if (depth + 1 > src.maxDepth) fail('depth limit');
      if (st.isDirectory()) {
        if (!privateDir(st)) fail('unsafe directory');
        entries.push({ kind: 'dir', path: rel });
        await walk(full, rel, depth + 1);
      } else if (st.isFile()) {
        if (st.nlink !== 1) fail('hardlink');
        const data = await checkedRead(full, parents);
        bytes += data.length;
        if (bytes > src.maxBytes) fail('byte limit');
        entries.push({ kind: 'file', path: rel, contentBase64: data.toString('base64') });
      } else fail('special file');
      await assertParents(parents);
    }
    const after = await lstatRequired(dir);
    if (!same(after, { path: dir, dev: Number(before.dev), ino: Number(before.ino) })) fail('directory identity changed');
    await assertParents(parents);
  };
  await walk(root, '', 0);
  const afterRoot = await lstatRequired(root);
  if (!same(afterRoot, { path: root, dev: Number(rootSt.dev), ino: Number(rootSt.ino) })) fail('root identity changed');
  await assertParents(rootParents);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { version: 1, entries };
}
function encodeSnapshot(snapshot: Snapshot): string { return JSON.stringify(snapshot); }
function markerPath(parent: string): string { return join(parent, MARKER); }
function localName(value: unknown, root: string, kind: 'stage' | 'backup'): string | null {
  const expected = new RegExp(`^\\.${basename(root).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\.mat-${kind}-[0-9a-f]{12}$`);
  return typeof value === 'string' && expected.test(value) ? value : null;
}
async function assertNoExtraCandidates(parent: string, root: string, marker: TxnMarker): Promise<void> {
  const proof = await reviewParents(join(parent, '.candidate'), false);
  await assertParents(proof);
  const prefix = `.${basename(root)}.mat-`;
  const names = await fs.readdir(parent);
  await assertParents(proof);
  const expected = new Set([marker.stage, marker.backup]);
  for (const name of names) {
    if (name.startsWith(prefix) && STAGING_NAME.test(name) && !expected.has(name)) fail('ambiguous transaction candidates');
  }
}
async function assertNoOrphanCandidates(parent: string, root: string): Promise<void> {
  const proof = await reviewParents(join(parent, '.candidate'), false);
  await assertParents(proof);
  const prefix = `.${basename(root)}.mat-`;
  const found = (await fs.readdir(parent)).some(name => name.startsWith(prefix) && STAGING_NAME.test(name));
  await assertParents(proof);
  if (found) fail('orphan transaction candidates');
}

async function writeMarker(parent: string, marker: TxnMarker): Promise<void> {
  const parents = await reviewParents(markerPath(parent), false);
  await writePrivateFile(markerPath(parent), Buffer.from(JSON.stringify(marker)), parents);
}
async function clearMarker(parent: string): Promise<void> {
  const path = markerPath(parent);
  const parents = await reviewParents(path, false);
  await assertParents(parents);
  const st = await fs.lstat(path).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
  if (st == null) return;
  if (st.isSymbolicLink() || !st.isFile() || st.nlink !== 1) fail('unsafe transaction marker');
  await assertParents(parents);
  await fs.unlink(path);
  await syncDirectory(parent);
  await assertParents(parents);
}
async function readMarker(parent: string): Promise<TxnMarker | null> {
  const path = markerPath(parent);
  let raw: string;
  try { raw = (await checkedRead(path)).toString('utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  let marker: Partial<TxnMarker>;
  try { marker = JSON.parse(raw) as Partial<TxnMarker>; } catch { fail('malformed transaction marker'); }
  if (marker.version !== 1 || typeof marker.root !== 'string' || typeof marker.intent !== 'string' || !/^[0-9a-f]{64}$/.test(marker.intent) || !['prepared', 'backed-up', 'activated'].includes(String(marker.phase))) fail('invalid transaction marker');
  return marker as TxnMarker;
}

/** Checked recursive removal: validate complete candidate first, then revalidate each unlink/rmdir. */
async function rmChecked(src: DirectorySource, path: string): Promise<void> {
  await captureTree(src, path);
  const remove = async (dir: string): Promise<void> => {
    const parents = await reviewParents(dir, false);
    await assertParents(parents);
    const before = await lstatRequired(dir);
    if (!privateDir(before)) fail('remove target');
    const names = await fs.readdir(dir);
    await assertParents(parents);
    for (const name of names) {
      if (name.normalize('NFC') !== name || DANGEROUS.has(name)) fail('unsafe remove descendant');
      const child = join(dir, name);
      const st = await lstatRequired(child);
      if (st.isDirectory()) await remove(child);
      else if (st.isFile() && st.nlink === 1) {
        await assertParents(parents);
        const again = await lstatRequired(child);
        if (!same(again, { path: child, dev: Number(st.dev), ino: Number(st.ino) }) || !again.isFile() || again.nlink !== 1) fail('remove identity changed');
        await removePinnedChild(dir, name, 'file', { dev: Number(before.dev), ino: Number(before.ino) }, { dev: Number(again.dev), ino: Number(again.ino) });
        await syncDirectory(dir);
        await assertParents(parents);
      } else fail('unsafe remove descendant');
    }
    await assertParents(parents);
    const after = await lstatRequired(dir);
    if (!same(after, { path: dir, dev: Number(before.dev), ino: Number(before.ino) })) fail('remove identity changed');
    const parentIdentity = parents.at(-1);
    if (!parentIdentity || parentIdentity.path !== dirname(dir)) fail('remove parent identity missing');
    await removePinnedChild(dirname(dir), basename(dir), 'directory', parentIdentity, { dev: Number(after.dev), ino: Number(after.ino) });
    await syncDirectory(dirname(dir));
    await assertParents(parents);
  };
  await remove(path);
}

async function candidateSnapshot(src: DirectorySource, path: string): Promise<Snapshot | null> {
  try { await fs.lstat(path); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  // Only the root lstat above carries missing-root semantics.  A later ENOENT is
  // an operation race and must fail closed rather than erasing evidence.
  return captureTree(src, path);
}
async function checkedRename(from: string, to: string): Promise<void> {
  const fromParents = await reviewParents(from, false);
  const toParents = await reviewParents(to, false);
  await assertParents(fromParents); await assertParents(toParents);
  const source = await lstatRequired(from);
  if (!source.isDirectory() || !privateDir(source)) fail('unsafe rename source');
  const destination = await fs.lstat(to).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
  if (destination != null) fail('unsafe rename destination');
  await assertParents(fromParents); await assertParents(toParents);
  const sourceAgain = await lstatRequired(from);
  if (!same(sourceAgain, { path: from, dev: Number(source.dev), ino: Number(source.ino) })) fail('rename source identity changed');
  await fs.rename(from, to);
  await syncDirectory(dirname(from));
  await assertParents(fromParents); await assertParents(toParents);
  const activated = await lstatRequired(to);
  if (!same(activated, { path: to, dev: Number(source.dev), ino: Number(source.ino) })) fail('rename activation identity changed');
}

/** Recover only a uniquely provable marker state; all candidates get full bounded validation. */
async function recoverDirectoryTxn(src: DirectorySource, parent: string, root: string): Promise<void> {
  const marker = await readMarker(parent);
  if (!marker) { await assertNoOrphanCandidates(parent, root); return; }
  if (marker.root !== basename(root)) fail('invalid transaction marker');
  const stageName = localName(marker.stage, root, 'stage'); const backupName = localName(marker.backup, root, 'backup');
  if (!stageName || !backupName) fail('invalid transaction marker');
  await assertNoExtraCandidates(parent, root, marker);
  const stage = join(parent, marker.stage); const backup = join(parent, marker.backup);
  const [live, staged, backed] = await Promise.all([candidateSnapshot(src, root), candidateSnapshot(src, stage), candidateSnapshot(src, backup)]);
  const isIntent = (candidate: Snapshot | null) => candidate != null && digest(encodeSnapshot(candidate)) === marker.intent;
  if (marker.phase === 'prepared' && live && staged && !backed && isIntent(staged)) {
    await rmChecked(src, stage); await clearMarker(parent); return;
  }
  if (marker.phase === 'prepared' && !live && staged && !backed && isIntent(staged)) {
    await checkedRename(stage, root); if (!isIntent(await candidateSnapshot(src, root))) fail('recovery activation verification failed'); await clearMarker(parent); return;
  }
  // No old root existed. If activation passed rename but verification failed,
  // recovery restores the prior absence only after fully validating the live
  // candidate; no ambiguous tree is ever deleted.
  if (marker.phase === 'prepared' && live && !staged && !backed && isIntent(live)) {
    await rmChecked(src, root); await clearMarker(parent); return;
  }
  if (marker.phase === 'backed-up' && !live && staged && backed && isIntent(staged)) {
    await checkedRename(stage, root);
    if (!isIntent(await candidateSnapshot(src, root))) fail('recovery activation verification failed');
    await rmChecked(src, backup); await clearMarker(parent); return;
  }
  if (marker.phase === 'activated' && live && !staged && backed && isIntent(live)) {
    await rmChecked(src, backup); await clearMarker(parent); return;
  }
  if (marker.phase === 'activated' && live && !staged && !backed && isIntent(live)) { await clearMarker(parent); return; }
  fail('ambiguous transaction recovery');
}

/** Capture a canonical V1 tree without following links or serializing metadata. */
export async function readDirectorySource(src: DirectorySource): Promise<string | null> {
  try {
    const root = expandTilde(src.path);
    try { await reviewParents(root, false); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
    await recoverDirectoryTxn(src, dirname(root), root);
    const snapshot = await candidateSnapshot(src, root);
    return snapshot == null ? null : encodeSnapshot(snapshot);
  } catch (err) { throw publicError(err); }
}

/** Metadata-only topology check used by doctor/detector; regular files are never opened. */
export async function directorySourceExists(src: DirectorySource): Promise<boolean> {
  try {
    const root = expandTilde(src.path);
    try { await reviewParents(root, false); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
    await recoverDirectoryTxn(src, dirname(root), root);
    // captureTree performs the same topology/resource/link checks. Its byte read is
    // deliberately avoided here; doctor/detector must never inspect secret bytes.
    const parents = await reviewParents(root, false);
    let rootSt: Awaited<ReturnType<typeof fs.lstat>>;
    try { rootSt = await lstatRequired(root); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
    if (!privateDir(rootSt)) fail('unsafe root');
    let entries = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      const proof = await reviewParents(dir, false); await assertParents(proof);
      const before = await lstatRequired(dir); if (!privateDir(before)) fail('unsafe directory');
      const names = await fs.readdir(dir); const folded = new Set<string>(); await assertParents(proof);
      for (const name of names) {
        const key = name.normalize('NFC').toLocaleLowerCase('en-US');
        if (name.normalize('NFC') !== name || DANGEROUS.has(name) || folded.has(key)) fail('unsafe entry name');
        folded.add(key); const child = join(dir, name); const st = await lstatRequired(child);
        if (++entries > src.maxEntries || depth + 1 > src.maxDepth) fail('directory limits');
        if (st.isDirectory()) { if (!privateDir(st)) fail('unsafe directory'); await walk(child, depth + 1); }
        else if (!st.isFile() || st.nlink !== 1) fail('unsafe file');
      }
      const after = await lstatRequired(dir); if (!same(after, { path: dir, dev: Number(before.dev), ino: Number(before.ino) })) fail('directory identity changed');
      await assertParents(proof);
    };
    await walk(root, 0); await assertParents(parents); return true;
  } catch (err) { throw publicError(err); }
}

export function parseDirectorySnapshot(value: string, src: DirectorySource): Snapshot {
  if (Buffer.byteLength(value) > MAX_SERIALIZED_BYTES) fail('serialized size');
  let raw: unknown; try { raw = JSON.parse(value); } catch { fail('malformed snapshot'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || Object.keys(raw).length !== 2 || !own(raw, 'version') || !own(raw, 'entries') || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { entries: unknown }).entries)) fail('invalid snapshot schema');
  const entries: Entry[] = []; let bytes = 0; let last = ''; const seen = new Set<string>(); const kinds = new Map<string, 'dir' | 'file'>();
  for (const rawEntry of (raw as { entries: unknown[] }).entries) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) fail('invalid entry');
    const entry = rawEntry as Record<string, unknown>; const path = safeRelative(entry.path, src.maxDepth); const kind = entry.kind;
    const keys = Object.keys(entry).sort().join(',');
    if ((kind === 'dir' && keys !== 'kind,path') || (kind === 'file' && keys !== 'contentBase64,kind,path')) fail('unknown entry key');
    const folded = path.normalize('NFC').toLocaleLowerCase('en-US');
    if (seen.has(folded)) fail('duplicate/case-fold path'); if (path <= last) fail('noncanonical entry order');
    last = path; seen.add(folded); if (entries.length >= src.maxEntries) fail('entry limit');
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
    if (parent && kinds.get(parent) !== 'dir') fail('missing or file parent');
    if (kind === 'dir') { kinds.set(path, 'dir'); entries.push({ kind, path }); }
    else if (kind === 'file' && typeof entry.contentBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(entry.contentBase64)) {
      if (entry.contentBase64.length > src.maxBytes * 2) fail('encoded size'); const decoded = Buffer.from(entry.contentBase64, 'base64');
      if (decoded.toString('base64') !== entry.contentBase64) fail('noncanonical base64'); bytes += decoded.length; if (bytes > src.maxBytes) fail('byte limit');
      kinds.set(path, 'file'); entries.push({ kind, path, contentBase64: entry.contentBase64 });
    } else fail('invalid file entry');
  }
  return { version: 1, entries };
}

async function restoreBackupAfterVerificationFailure(src: DirectorySource, root: string, backup: string, primary: unknown): Promise<never> {
  void primary;
  try {
    await rmChecked(src, root);
    await checkedRename(backup, root);
  } catch { fail('activation verification failed; backup preserved; rollback failed'); }
  fail('activation verification failed; backup restored');
}

/** Restore from a validated V1 tree by staged same-parent activation and byte-for-byte verification. */
export async function writeDirectorySource(src: DirectorySource, value: string): Promise<void> {
  try {
  const snapshot = parseDirectorySnapshot(value, src); const intended = encodeSnapshot(snapshot); const root = expandTilde(src.path);
  await reviewParents(root, true); await recoverDirectoryTxn(src, dirname(root), root); await reviewParents(root, true);
  const parent = dirname(root); const stage = join(parent, `.${basename(root)}.mat-stage-${randomBytes(6).toString('hex')}`); const backup = join(parent, `.${basename(root)}.mat-backup-${randomBytes(6).toString('hex')}`);
  const parentProof = await reviewParents(stage, false);
  await assertParents(parentProof); await fs.mkdir(stage, { mode: 0o700 }); await assertParents(parentProof);
  try {
    for (const entry of snapshot.entries) {
      const destination = join(stage, ...entry.path.split('/'));
      if (!destination.startsWith(stage + sep)) fail('escape');
      const proof = await reviewParents(destination, false);
      if (entry.kind === 'dir') { await assertParents(proof); await fs.mkdir(destination, { mode: 0o700 }); await assertParents(proof); if (!privateDir(await lstatRequired(destination))) fail('unsafe staging directory'); }
      else await writePrivateFile(destination, Buffer.from(entry.contentBase64, 'base64'), proof);
    }
    if (encodeSnapshot(await captureTree(src, stage)) !== intended) fail('staging verification failed');
    const existing = await candidateSnapshot(src, root); // full live validation before it can become backup
    const marker: TxnMarker = { version: 1, root: basename(root), stage: basename(stage), backup: basename(backup), intent: digest(intended), phase: 'prepared' };
    await writeMarker(parent, marker);
    // Validate the entire live candidate again at the exact activation edge;
    // an earlier preflight is not authority to rename a subsequently swapped tree.
    if (existing) {
      await captureTree(src, root);
      try {
        await checkedRename(root, backup);
        marker.phase = 'backed-up';
        await writeMarker(parent, marker);
      } catch {
        try {
          if (!(await pathExists(root)) && await pathExists(backup)) await checkedRename(backup, root);
          if (await pathExists(stage)) await rmChecked(src, stage);
          await clearMarker(parent);
        } catch { fail('backup preparation failed; rollback failed'); }
        fail('backup preparation failed; prior live restored');
      }
    }
    try {
      await checkedRename(stage, root);
    } catch {
      try {
        if (existing) await checkedRename(backup, root);
        else if (await pathExists(root)) await rmChecked(src, root);
        if (await pathExists(stage)) await rmChecked(src, stage);
        await clearMarker(parent);
      } catch { fail(existing ? 'activation failed; backup rollback failed' : 'activation failed; rollback-to-absence failed'); }
      fail(existing ? 'activation failed; prior live restored' : 'activation failed; prior absence restored');
    }
    try {
      const live = await candidateSnapshot(src, root);
      if (!live || encodeSnapshot(live) !== intended) fail('activation verification failed');
    } catch (err) {
      if (existing) await restoreBackupAfterVerificationFailure(src, root, backup, err);
      // A first activation has no backup. Restore the recorded prior absence;
      // if removal cannot be proven safe, preserve marker + live evidence.
      try { await rmChecked(src, root); await clearMarker(parent); }
      catch { fail('activation verification failed; rollback-to-absence failed'); }
      throw err;
    }
    marker.phase = 'activated';
    try { await writeMarker(parent, marker); }
    catch {
      try {
        if (existing) { await rmChecked(src, root); await checkedRename(backup, root); }
        else await rmChecked(src, root);
        await clearMarker(parent);
      } catch { fail(existing ? 'activation marker failed; backup rollback failed' : 'activation marker failed; rollback-to-absence failed'); }
      fail(existing ? 'activation marker failed; prior live restored' : 'activation marker failed; prior absence restored');
    }
    if (existing) await rmChecked(src, backup);
    await clearMarker(parent);
  } catch (err) {
    // Before a marker exists, a fully validated stage is disposable. Once the
    // marker exists, retain every candidate as recovery evidence on any failure.
    if (!(await pathExists(markerPath(parent))) && await pathExists(stage)) {
      try { await rmChecked(src, stage); } catch { /* retain ambiguous stage */ }
    }
    throw err;
  }
  } catch (err) { throw publicError(err); }
}

export async function removeDirectorySource(src: DirectorySource): Promise<void> {
  try {
    const root = expandTilde(src.path);
    try { await reviewParents(root, false); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
    await recoverDirectoryTxn(src, dirname(root), root);
    if (!(await pathExists(root))) return;
    await rmChecked(src, root);
  } catch (err) { throw publicError(err); }
}
