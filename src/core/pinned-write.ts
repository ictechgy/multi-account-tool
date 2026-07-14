/**
 * Atomically replace one reviewed provider file relative to a helper process's
 * cwd inode. Node does not expose openat(2)/renameat(2), so the child resolves
 * the reviewed parent as cwd once and uses relative basenames exclusively.
 * Credential bytes are delivered only over stdin.
 */
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

export interface PinnedWriteIdentity { dev: number; ino: number; }
export type PinnedWriteExpected = { kind: 'absent' } | ({ kind: 'present' } & PinnedWriteIdentity);
export type PinnedWriteFaultStage = 'after-open' | 'after-create' | 'after-write' | 'before-rename' | 'after-rename';
export type PinnedWritePauseStage = 'after-pin' | 'before-rename';

export interface PinnedWriteContext {
  parent: string;
  name: string;
  tempName: string;
  expected: PinnedWriteExpected;
}

interface PinnedWriteTestHooks {
  beforeSpawn?: (context: PinnedWriteContext) => void | Promise<void>;
  faultStage?: (context: PinnedWriteContext) => PinnedWriteFaultStage | undefined;
  pauseStage?: (context: PinnedWriteContext) => PinnedWritePauseStage | undefined;
  atStage?: (context: PinnedWriteContext, stage: PinnedWritePauseStage) => void | Promise<void>;
}

let testHooks: PinnedWriteTestHooks | undefined;

/** Deterministic structural race/fault seams. Tests must restore with `null`. */
export function __setPinnedWriteTestHooksForTests(hooks: PinnedWriteTestHooks | null): void {
  testHooks = hooks ?? undefined;
}

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const HELPER_TIMEOUT_MS = 5_000;
const HELPER_MAX_BUFFER = 1_024;
const STAGE_SIGNAL = 'MAT_PINNED_WRITE_STAGE\n';

const SCRIPT = String.raw`
const fs = require('node:fs');
const c = fs.constants;
let input;
try { input = JSON.parse(process.argv[1]); } catch { process.exit(70); }

const same = (st, identity) => Number(st.dev) === identity.dev && Number(st.ino) === identity.ino;
const safeName = (name) => typeof name === 'string' && name.length <= 255 && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
const fail = (code) => { const error = new Error('refused'); error.exitCode = code; throw error; };
const parentOk = () => {
  const st = fs.lstatSync('.');
  if (!st.isDirectory() || !same(st, input.parent)) fail(71);
};
const target = () => {
  try { return fs.lstatSync(input.name); }
  catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
};
const targetOk = () => {
  const st = target();
  if (input.expected.kind === 'absent') {
    if (st !== null) fail(72);
    return;
  }
  if (st === null || st.isSymbolicLink() || !st.isFile() || st.nlink !== 1 || !same(st, input.expected)) fail(73);
};
const stagedOk = (fd, identity) => {
  const opened = fs.fstatSync(fd);
  const named = fs.lstatSync(input.tempName);
  if (!opened.isFile() || opened.nlink !== 1 || (Number(opened.mode) & 0o777) !== 0o600 ||
      named.isSymbolicLink() || !named.isFile() || named.nlink !== 1 || !same(opened, identity) || !same(named, identity)) fail(74);
};

if (!safeName(input.name) || !safeName(input.tempName) || input.name === input.tempName ||
    !input.parent || !Number.isSafeInteger(input.parent.dev) || !Number.isSafeInteger(input.parent.ino) ||
    !input.expected || !['absent', 'present'].includes(input.expected.kind) ||
    (input.expected.kind === 'present' && (!Number.isSafeInteger(input.expected.dev) || !Number.isSafeInteger(input.expected.ino))) ||
    !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 0 ||
    (input.faultStage !== undefined && !['after-open', 'after-create', 'after-write', 'before-rename', 'after-rename'].includes(input.faultStage)) ||
    (input.pauseStage !== undefined && !['after-pin', 'before-rename'].includes(input.pauseStage))) process.exit(70);

try { parentOk(); targetOk(); } catch (error) { process.exit(error.exitCode || 75); }

const chunks = [];
let bytes = 0;
process.stdin.on('data', (chunk) => {
  bytes += chunk.length;
  if (bytes > input.maxBytes) process.exit(76);
  chunks.push(chunk);
});
process.stdin.on('error', () => process.exit(77));
process.stdin.on('end', async () => {
  let fd;
  let tempCreated = false;
  let tempIdentity;
  const cleanup = () => {
    if (tempCreated && !tempIdentity && fd !== undefined) {
      try {
        const opened = fs.fstatSync(fd);
        if (opened.isFile() && opened.nlink === 1) tempIdentity = { dev: Number(opened.dev), ino: Number(opened.ino) };
      } catch {}
    }
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} fd = undefined; }
    if (tempCreated && tempIdentity) {
      try {
        const named = fs.lstatSync(input.tempName);
        if (!named.isSymbolicLink() && named.isFile() && named.nlink === 1 && same(named, tempIdentity)) fs.unlinkSync(input.tempName);
      } catch {}
    }
  };
  const checkpoint = async (stage) => {
    if (input.pauseStage !== stage) return;
    await new Promise((resolve) => {
      const keepAlive = setInterval(() => {}, 1_000);
      process.once('SIGCONT', () => { clearInterval(keepAlive); resolve(); });
      process.stdout.write(${JSON.stringify(STAGE_SIGNAL)});
    });
  };
  process.once('SIGTERM', () => { cleanup(); process.exit(81); });
  process.once('SIGINT', () => { cleanup(); process.exit(81); });
  try {
    parentOk(); targetOk();
    await checkpoint('after-pin');
    fd = fs.openSync(input.tempName, c.O_WRONLY | c.O_CREAT | c.O_EXCL | c.O_NOFOLLOW, 0o600);
    tempCreated = true;
    if (input.faultStage === 'after-open') fail(78);
    const created = fs.fstatSync(fd);
    tempIdentity = { dev: Number(created.dev), ino: Number(created.ino) };
    fs.fchmodSync(fd, 0o600);
    stagedOk(fd, tempIdentity);
    if (input.faultStage === 'after-create') fail(78);
    fs.writeFileSync(fd, Buffer.concat(chunks));
    fs.fsyncSync(fd);
    const staged = fs.fstatSync(fd);
    stagedOk(fd, { dev: Number(staged.dev), ino: Number(staged.ino) });
    if (input.faultStage === 'after-write') fail(78);
    await checkpoint('before-rename');
    parentOk(); targetOk();
    if (input.faultStage === 'before-rename') fail(78);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(input.tempName, input.name);
    tempCreated = false;
    const activated = fs.lstatSync(input.name);
    if (activated.isSymbolicLink() || !activated.isFile() || activated.nlink !== 1 || !same(activated, staged)) fail(79);
    parentOk();
    if (input.faultStage === 'after-rename') fail(78);
    const parentFd = fs.openSync('.', c.O_RDONLY | c.O_DIRECTORY | c.O_NOFOLLOW);
    try {
      const parent = fs.fstatSync(parentFd);
      if (!parent.isDirectory() || !same(parent, input.parent)) fail(71);
      fs.fsyncSync(parentFd);
    } finally { fs.closeSync(parentFd); }
    parentOk();
  } catch (error) {
    process.exitCode = error.exitCode || 80;
  } finally {
    cleanup();
  }
});
`;

function safeBasename(name: string): boolean {
  return name.length <= 255 && /^[A-Za-z0-9._-]+$/.test(name) && name !== '.' && name !== '..';
}

function refused(): Error { return new Error('pinned provider write refused'); }

export async function writePinnedProviderFile(
  parent: string,
  name: string,
  value: string,
  parentIdentity: PinnedWriteIdentity,
  expected: PinnedWriteExpected
): Promise<void> {
  if (!safeBasename(name) || !Number.isSafeInteger(parentIdentity.dev) || !Number.isSafeInteger(parentIdentity.ino) || Buffer.byteLength(value) > MAX_INPUT_BYTES) {
    throw refused();
  }
  const tempName = `.${name}.mat-write-${randomBytes(6).toString('hex')}`;
  const context: PinnedWriteContext = { parent, name, tempName, expected };
  await testHooks?.beforeSpawn?.(context);
  const faultStage = testHooks?.faultStage?.(context);
  const pauseStage = testHooks?.pauseStage?.(context);
  const metadata = JSON.stringify({
    name,
    tempName,
    parent: { dev: parentIdentity.dev, ino: parentIdentity.ino },
    expected: expected.kind === 'present'
      ? { kind: 'present', dev: expected.dev, ino: expected.ino }
      : { kind: 'absent' },
    maxBytes: MAX_INPUT_BYTES,
    faultStage,
    pauseStage
  });

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (error) reject(error); else resolve();
    };
    const child = execFile(process.execPath, ['-e', SCRIPT, metadata], {
      cwd: parent,
      encoding: 'utf8',
      timeout: HELPER_TIMEOUT_MS,
      maxBuffer: HELPER_MAX_BUFFER,
      windowsHide: true
    }, (error) => settle(error ? refused() : undefined));
    let stageOutput = '';
    let stageHandled = false;
    child.stdout?.on('data', (chunk) => {
      if (stageHandled) return;
      stageOutput = (stageOutput + chunk.toString()).slice(-HELPER_MAX_BUFFER);
      if (!stageOutput.includes(STAGE_SIGNAL)) return;
      stageHandled = true;
      void Promise.resolve(testHooks?.atStage?.(context, pauseStage!)).then(() => {
        if (!settled) {
          try { child.kill('SIGCONT'); } catch { settle(refused()); }
        }
      }, () => {
        try { child.kill('SIGKILL'); } catch { /* best effort */ }
        settle(refused());
      });
    });
    child.stdin?.once('error', () => {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      settle(refused());
    });
    try { child.stdin?.end(value, 'utf8'); }
    catch {
      try { child.kill('SIGKILL'); } catch { /* best effort */ }
      settle(refused());
    }
  });
}
