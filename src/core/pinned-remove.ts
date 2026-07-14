/**
 * Remove one already-reviewed child relative to a cwd inode pinned by a helper
 * process. Node does not expose unlinkat(2); a checked child cwd provides the
 * same ancestor-swap property without changing the parent process cwd.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PinnedIdentity { dev: number; ino: number; }

export interface PinnedRemoveContext { parent: string; name: string; kind: 'file' | 'directory'; }
let beforePinnedRemove: ((context: PinnedRemoveContext) => void | Promise<void>) | undefined;

/** Deterministic ancestor-swap seam. Tests must restore with `null`. */
export function __setBeforePinnedRemoveForTests(hook: ((context: PinnedRemoveContext) => void | Promise<void>) | null): void {
  beforePinnedRemove = hook ?? undefined;
}

const SCRIPT = String.raw`
const fs = require('node:fs');
const input = JSON.parse(process.argv[1]);
try {
  const parent = fs.lstatSync('.');
  if (!parent.isDirectory() || Number(parent.dev) !== input.parent.dev || Number(parent.ino) !== input.parent.ino) process.exit(73);
  const child = fs.lstatSync(input.name);
  const typeOk = input.kind === 'file' ? child.isFile() && child.nlink === 1 : child.isDirectory();
  if (!typeOk || Number(child.dev) !== input.child.dev || Number(child.ino) !== input.child.ino) process.exit(74);
  if (input.kind === 'file') fs.unlinkSync(input.name); else fs.rmdirSync(input.name);
} catch { process.exit(75); }
`;

export async function removePinnedChild(
  parent: string,
  name: string,
  kind: 'file' | 'directory',
  parentIdentity: PinnedIdentity,
  childIdentity: PinnedIdentity
): Promise<void> {
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new Error('pinned removal refused');
  }
  await beforePinnedRemove?.({ parent, name, kind });
  try {
    await execFileAsync(process.execPath, ['-e', SCRIPT, JSON.stringify({ name, kind, parent: parentIdentity, child: childIdentity })], {
      cwd: parent,
      encoding: 'utf8',
      timeout: 5_000,
      maxBuffer: 1_024
    });
  } catch {
    throw new Error('pinned removal refused');
  }
}
