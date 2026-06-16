import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  readWindowsCredentialSourceSerialized,
  windowsCredentialSourceExists,
  writeWindowsCredentialSourceSerialized
} from '../../src/core/windows-credential-source.js';
import {
  WindowsCredentialError,
  deleteWindowsCredential,
  makeSyntheticWindowsCredentialBinding,
  readWindowsCredentialSerialized,
  validateWindowsCredentialBinding,
  windowsCredentialExists,
  writeWindowsCredentialSerialized,
  type WindowsCredentialBinding,
  type WindowsCredentialBridge,
  type WindowsCredentialBridgeInspectResult,
  type WindowsCredentialBridgeReadResult,
  type WindowsCredentialBridgeWriteRequest,
  type WindowsCredentialStoredV1
} from '../../src/core/windows-credential-manager.js';
import type { WindowsCredentialSource } from '../../src/core/types.js';

const CANARY_NEW = 'fixture-windows-credential-manager-new-20260616';
const CANARY_OLD = 'fixture-windows-credential-manager-old-20260616';
const CANARY_RAW = 'fixture-windows-credential-manager-raw-output-20260616';

const binding: WindowsCredentialBinding = {
  targetName: 'mat-test/unit/example',
  credentialType: 'generic',
  account: 'mat-unit-account',
  persist: 'session'
};

const source: WindowsCredentialSource = {
  type: 'win-credential',
  targetName: binding.targetName,
  credentialType: 'generic',
  account: binding.account ?? 'mat-unit-account',
  persist: binding.persist ?? 'session',
  saveAs: 'credentials.json'
};

class FakeBridge implements WindowsCredentialBridge {
  readonly inspects: WindowsCredentialBinding[] = [];
  readonly reads: WindowsCredentialBinding[] = [];
  readonly guardedReads: WindowsCredentialBinding[] = [];
  readonly writes: WindowsCredentialBridgeWriteRequest[] = [];
  readonly guardedWrites: WindowsCredentialBridgeWriteRequest[] = [];
  readonly deletes: WindowsCredentialBinding[] = [];

  constructor(
    private readonly readQueue: Array<WindowsCredentialBridgeReadResult | Error> = [{ status: 'missing' }],
    private readonly writeQueue: Array<Error | 'ok'> = ['ok'],
    private readonly deleteQueue: Array<Error | 'deleted' | 'missing'> = ['missing'],
    private readonly inspectQueue: Array<WindowsCredentialBridgeInspectResult | Error> = [{ status: 'missing' }]
  ) {}

  async inspect(nextBinding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeInspectResult> {
    this.inspects.push(nextBinding);
    const next = this.inspectQueue.length > 0 ? this.inspectQueue.shift()! : { status: 'missing' as const };
    if (next instanceof Error) throw next;
    return next;
  }

  async read(nextBinding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeReadResult> {
    this.reads.push(nextBinding);
    const next = this.readQueue.length > 0 ? this.readQueue.shift()! : { status: 'missing' as const };
    if (next instanceof Error) throw next;
    return next;
  }

  async readGuarded(nextBinding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeReadResult> {
    this.guardedReads.push(nextBinding);
    const next = this.readQueue.length > 0 ? this.readQueue.shift()! : { status: 'missing' as const };
    if (next instanceof Error) throw next;
    if (next.status === 'present' && nextBinding.account !== undefined && next.account !== nextBinding.account) {
      throw new WindowsCredentialError('account-mismatch', 'windows credential account metadata does not match binding');
    }
    return next;
  }

  async write(request: WindowsCredentialBridgeWriteRequest): Promise<void> {
    this.writes.push(request);
    const next = this.writeQueue.length > 0 ? this.writeQueue.shift()! : 'ok';
    if (next instanceof Error) throw next;
  }

  async writeGuarded(request: WindowsCredentialBridgeWriteRequest): Promise<void> {
    this.guardedWrites.push(request);
    const next = this.writeQueue.length > 0 ? this.writeQueue.shift()! : 'ok';
    if (next instanceof Error) throw next;
  }

  async delete(nextBinding: WindowsCredentialBinding): Promise<'deleted' | 'missing'> {
    this.deletes.push(nextBinding);
    const next = this.deleteQueue.length > 0 ? this.deleteQueue.shift()! : 'missing';
    if (next instanceof Error) throw next;
    return next;
  }
}

function stored(nextBinding: WindowsCredentialBinding, secret: string, overrides: Partial<WindowsCredentialStoredV1> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    targetName: nextBinding.targetName,
    credentialType: 'generic',
    account: nextBinding.account,
    persist: nextBinding.persist ?? 'session',
    secret,
    ...overrides
  });
}

async function captureError(promise: Promise<unknown>): Promise<WindowsCredentialError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(WindowsCredentialError);
    return err as WindowsCredentialError;
  }
  throw new Error('expected WindowsCredentialError');
}

function serializedError(err: unknown): string {
  const keys = new Set(['name', 'message', 'code', 'details', 'stack']);
  if (err && typeof err === 'object') {
    for (const key of Object.getOwnPropertyNames(err)) keys.add(key);
  }
  return `${String(err)}\n${JSON.stringify(err, [...keys])}`;
}

function expectNoLeak(text: string, ...values: string[]): void {
  for (const value of values) expect(text).not.toContain(value);
}

describe('windows credential manager internal backend — fake bridge unit tests', () => {
  it('validates binding fields before bridge use and redacts target/account details', async () => {
    const bridge = new FakeBridge();
    const unsafeTarget = `mat-test/unit/${randomUUID()}\nspoof`;
    const err = await captureError(readWindowsCredentialSerialized({
      targetName: unsafeTarget,
      credentialType: 'generic',
      account: 'alice@example.com'
    }, { bridge }));

    expect(err.code).toBe('invalid-input');
    expect(bridge.reads.length).toBe(0);
    const text = serializedError(err);
    expectNoLeak(text, unsafeTarget, 'alice@example.com');
  });

  it('serializes a present credential without exposing values in assertions', async () => {
    const bridge = new FakeBridge([{ status: 'present', secret: CANARY_NEW, account: 'mat-unit-account', persist: 'session' }]);
    const raw = await readWindowsCredentialSerialized(binding, { bridge });
    if (raw == null) throw new Error('expected serialized credential');
    const parsed = JSON.parse(raw) as WindowsCredentialStoredV1;

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.targetName).toBe(binding.targetName);
    expect(parsed.credentialType).toBe('generic');
    expect(parsed.persist).toBe('session');
    expect(parsed.secret === CANARY_NEW).toBe(true);
  });

  it('returns false/missing for cleanly missing credentials', async () => {
    const bridge = new FakeBridge([{ status: 'missing' }], [], ['missing']);
    expect(await readWindowsCredentialSerialized(binding, { bridge })).toBeNull();
    expect(await windowsCredentialExists(binding, { bridge })).toBe(false);
    expect(await deleteWindowsCredential(binding, { bridge })).toBe('missing');
  });

  it('checks existence through metadata-only inspect without reading the secret', async () => {
    const bridge = new FakeBridge(
      [new Error(`${CANARY_RAW} ${CANARY_NEW}`)],
      [],
      [],
      [{ status: 'present', account: 'mat-unit-account', persist: 'session' }]
    );

    expect(await windowsCredentialExists(binding, { bridge })).toBe(true);
    expect(bridge.inspects.length).toBe(1);
    expect(bridge.reads.length).toBe(0);
  });

  it('fails closed on account metadata mismatch before reading the secret', async () => {
    const bridge = new FakeBridge(
      [new Error(`${CANARY_RAW} ${CANARY_NEW}`)],
      [],
      [],
      [{ status: 'present', account: 'other-account', persist: 'session' }]
    );
    const err = await captureError(windowsCredentialExists(binding, { bridge }));

    expect(err.code).toBe('account-mismatch');
    expect(bridge.inspects.length).toBe(1);
    expect(bridge.reads.length).toBe(0);
    expectNoLeak(serializedError(err), 'other-account', binding.account ?? '', binding.targetName);
  });

  it('rejects malformed backups before any read/write mutation', async () => {
    const bridge = new FakeBridge();
    const wrongTarget = stored(binding, CANARY_NEW, { targetName: 'mat-test/unit/other' });
    const err = await captureError(writeWindowsCredentialSerialized(binding, wrongTarget, { bridge }));

    expect(err.code).toBe('malformed-backup');
    expect(bridge.reads.length).toBe(0);
    expect(bridge.writes.length).toBe(0);
    expectNoLeak(serializedError(err), CANARY_NEW, 'mat-test/unit/other');
  });

  it('writes a new credential after a missing backup preflight', async () => {
    const bridge = new FakeBridge([{ status: 'missing' }], ['ok']);
    await writeWindowsCredentialSerialized(binding, stored(binding, CANARY_NEW), { bridge });

    expect(bridge.reads.length).toBe(1);
    expect(bridge.writes.length).toBe(1);
    expect(bridge.writes[0]?.secret === CANARY_NEW).toBe(true);
    expect(bridge.writes[0]?.secret).not.toBe(CANARY_OLD);
  });

  it('restores the old credential when write fails after backup', async () => {
    const bridge = new FakeBridge(
      [{ status: 'present', secret: CANARY_OLD, account: 'mat-unit-account', persist: 'session' }],
      [new Error(`${CANARY_RAW} ${CANARY_NEW}`), 'ok']
    );
    const err = await captureError(writeWindowsCredentialSerialized(binding, stored(binding, CANARY_NEW), { bridge }));

    expect(err.code).toBe('write-failed');
    expect(bridge.writes.length).toBe(2);
    expect(bridge.writes[0]?.secret === CANARY_NEW).toBe(true);
    expect(bridge.writes[1]?.secret === CANARY_OLD).toBe(true);
    expectNoLeak(serializedError(err), CANARY_NEW, CANARY_OLD, CANARY_RAW, binding.targetName);
  });

  it('preserves backed-up account and persist metadata during rollback', async () => {
    const requestedBinding: WindowsCredentialBinding = {
      ...binding,
      account: 'mat-requested-account',
      persist: 'local-machine'
    };
    const bridge = new FakeBridge(
      [{ status: 'present', secret: CANARY_OLD, account: 'mat-original-account', persist: 'enterprise' }],
      [new Error(`${CANARY_RAW} ${CANARY_NEW}`), 'ok']
    );
    const err = await captureError(writeWindowsCredentialSerialized(
      requestedBinding,
      stored(requestedBinding, CANARY_NEW),
      { bridge }
    ));

    expect(err.code).toBe('write-failed');
    expect(bridge.writes.length).toBe(2);
    expect(bridge.writes[0]?.secret === CANARY_NEW).toBe(true);
    expect(bridge.writes[0]?.account).toBe('mat-requested-account');
    expect(bridge.writes[0]?.persist).toBe('local-machine');
    expect(bridge.writes[1]?.secret === CANARY_OLD).toBe(true);
    expect(bridge.writes[1]?.account).toBe('mat-original-account');
    expect(bridge.writes[1]?.persist).toBe('enterprise');
    expectNoLeak(serializedError(err), CANARY_NEW, CANARY_OLD, CANARY_RAW, binding.targetName);
  });

  it('reports rollback failure without leaking new, old, or raw bridge output', async () => {
    const bridge = new FakeBridge(
      [{ status: 'present', secret: CANARY_OLD, account: 'mat-unit-account', persist: 'session' }],
      [new Error(`${CANARY_RAW} ${CANARY_NEW}`), new Error(`${CANARY_RAW} ${CANARY_OLD}`)]
    );
    const err = await captureError(writeWindowsCredentialSerialized(binding, stored(binding, CANARY_NEW), { bridge }));

    expect(err.code).toBe('rollback-failed');
    expect(err.details.causeCode).toBe('write-failed');
    expect(err.details.rollbackCode).toBe('rollback-failed');
    expect(bridge.writes.length).toBe(2);
    expectNoLeak(serializedError(err), CANARY_NEW, CANARY_OLD, CANARY_RAW, binding.targetName);
  });

  it('validates secret blob size before bridge write', async () => {
    const bridge = new FakeBridge();
    const tooLarge = 'x'.repeat(1300); // UTF-16LE > CRED_MAX_CREDENTIAL_BLOB_SIZE (2560 bytes)
    const err = await captureError(writeWindowsCredentialSerialized(binding, stored(binding, tooLarge), { bridge }));

    expect(err.code).toBe('malformed-backup');
    expect(bridge.reads.length).toBe(0);
    expect(bridge.writes.length).toBe(0);
    expectNoLeak(serializedError(err), tooLarge, binding.targetName);
  });

  it('supports explicit local-machine and enterprise persist metadata without public source exposure', () => {
    expect(validateWindowsCredentialBinding({ ...binding, persist: 'local-machine' }).persist).toBe('local-machine');
    expect(validateWindowsCredentialBinding({ ...binding, persist: 'enterprise' }).persist).toBe('enterprise');
  });

  it('public win-credential source reads through guarded account check', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const bridge = new FakeBridge(
        [{ status: 'present', secret: CANARY_NEW, account: 'mat-unit-account', persist: 'session' }],
        [],
        []
      );
      const raw = await readWindowsCredentialSourceSerialized(source, { bridge });
      if (raw == null) throw new Error('expected serialized credential');
      const parsed = JSON.parse(raw) as WindowsCredentialStoredV1;

      expect(parsed.secret === CANARY_NEW).toBe(true);
      expect(parsed.account).toBe('mat-unit-account');
      expect(bridge.inspects.length).toBe(0);
      expect(bridge.guardedReads.length).toBe(1);
      expect(bridge.reads.length).toBe(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });

  it('public win-credential source write/exists fail closed on account mismatch before secret read or write', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const bridge = new FakeBridge(
        [{ status: 'present', secret: CANARY_OLD, account: 'other-account', persist: 'session' }],
        ['ok'],
        []
      );
      const err = await captureError(writeWindowsCredentialSourceSerialized(source, stored(binding, CANARY_NEW), { bridge }));

      expect(err.code).toBe('account-mismatch');
      expect(bridge.inspects.length).toBe(0);
      expect(bridge.guardedReads.length).toBe(1);
      expect(bridge.reads.length).toBe(0);
      expect(bridge.writes.length).toBe(0);
      expect(bridge.guardedWrites.length).toBe(0);
      expectNoLeak(serializedError(err), 'other-account', CANARY_NEW, CANARY_OLD, binding.targetName);

      const existsBridge = new FakeBridge(
        [new Error(`${CANARY_RAW} ${CANARY_OLD}`)],
        [],
        [],
        [{ status: 'present', account: 'other-account', persist: 'session' }]
      );
      const existsErr = await captureError(windowsCredentialSourceExists(source, { bridge: existsBridge }));
      expect(existsErr.code).toBe('account-mismatch');
      expect(existsBridge.reads.length).toBe(0);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});

describe('windows credential manager internal backend — product boundary', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

  async function read(rel: string): Promise<string> {
    return fs.readFile(join(repoRoot, rel), 'utf8');
  }

  it('exposes only the narrow public source primitive and keeps builtin/package Windows support blocked', async () => {
    const [types, plugin] = await Promise.all([
      read('src/core/types.ts'),
      read('src/core/cli-defs-plugin.ts')
    ]);

    const [cliDefs, pkg] = await Promise.all([
      read('src/core/cli-defs.ts'),
      read('package.json')
    ]);

    expect(types).toContain('win-credential');
    expect(plugin).toContain('win-credential');
    expect(cliDefs).not.toContain('windows-credential-manager');
    expect(cliDefs).not.toContain('win-credential');
    expect(pkg).toContain('"darwin"');
    expect(pkg).toContain('"linux"');
    expect(pkg).not.toContain('"win32"');
  });

  it('uses case-sensitive account comparison inside the PowerShell guarded bridge', async () => {
    const manager = await read('src/core/windows-credential-manager.ts');

    expect(manager).toContain('$ActualAccount -cne $Request.account');
    expect(manager).not.toContain('$ActualAccount -ne $Request.account');
  });
});

const itWindows = process.platform === 'win32' ? it : it.skip;

describe('windows credential manager internal backend — synthetic Windows integration', () => {
  itWindows('round-trips a synthetic generic credential and cleans up without logging secrets', async () => {
    const safeCaseName = `vitest-${randomUUID()}`;
    const liveBinding = makeSyntheticWindowsCredentialBinding(safeCaseName);
    const secretOne = `fixture-windows-live-one-${randomUUID()}`;
    const secretTwo = `fixture-windows-live-two-${randomUUID()}`;

    try {
      expect(await windowsCredentialExists(liveBinding)).toBe(false);
      expect(await readWindowsCredentialSerialized(liveBinding)).toBeNull();

      await writeWindowsCredentialSerialized(liveBinding, stored(liveBinding, secretOne));
      const firstRaw = await readWindowsCredentialSerialized(liveBinding);
      if (firstRaw == null) throw new Error('missing after first write');
      const first = JSON.parse(firstRaw) as WindowsCredentialStoredV1;
      if (first.secret !== secretOne) throw new Error('secret mismatch after first write');

      await writeWindowsCredentialSerialized(liveBinding, stored(liveBinding, secretTwo));
      const secondRaw = await readWindowsCredentialSerialized(liveBinding);
      if (secondRaw == null) throw new Error('missing after overwrite');
      const second = JSON.parse(secondRaw) as WindowsCredentialStoredV1;
      if (second.secret !== secretTwo) throw new Error('secret mismatch after overwrite');

      expect(await windowsCredentialExists(liveBinding)).toBe(true);
      expect(await deleteWindowsCredential(liveBinding)).toBe('deleted');
      expect(await readWindowsCredentialSerialized(liveBinding)).toBeNull();
      expect(await deleteWindowsCredential(liveBinding)).toBe('missing');
    } finally {
      await deleteWindowsCredential(liveBinding).catch(() => 'missing');
    }
  });
});
