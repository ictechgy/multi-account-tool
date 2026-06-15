import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

import { spawn } from 'node:child_process';

import {
  deleteEnvSecret,
  EnvSecretError,
  getEnvSecretMetadata,
  listEnvSecretMetadata,
  loadEnvSecret,
  storeEnvSecret,
  updateEnvSecret,
  type EnvSecretBinding
} from '../../src/core/env-secret.js';
import {
  classifyLssError,
  createLssEnvBackend,
  deleteResultToCleanupStatus,
  lssProofReport
} from '../../src/core/env-secret-linux-secret-service.js';
import * as osKeyringModule from '../../src/core/os-keyring.js';

const mockSpawn = vi.mocked(spawn);
const resetWarnForTest = osKeyringModule['reset' + 'SecretToolMissingWarnedForTest'];
const VALUE = 'secret-value-alpha';
const UPDATED = 'secret-value-bravo';
const RAW_OUTPUT = 'raw-store-output';
const ACCOUNT = 'synthetic-account';

const binding: EnvSecretBinding = {
  profileName: 'work',
  cliId: 'synthetic-cli',
  envName: 'MAT_TEST_SECRET',
  backend: { kind: 'linux-secret-service', handle: 'mat-env-secret-test' },
  accountKey: ACCOUNT
};

class FakeStdin extends EventEmitter {
  public readonly writes: string[] = [];
  public ended = false;
  write(chunk: string): boolean {
    this.writes.push(chunk);
    return true;
  }
  end(): void {
    this.ended = true;
  }
}

function spawnError(errno: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${errno}`) as NodeJS.ErrnoException;
  err.code = errno;
  return err;
}

function fakeProc(opts: {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: Error;
}): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: FakeStdin;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = new FakeStdin();
  setImmediate(() => {
    if (opts.error) {
      proc.emit('error', opts.error);
      return;
    }
    if (opts.stdout) proc.stdout.emit('data', Buffer.from(opts.stdout));
    if (opts.stderr) proc.stderr.emit('data', Buffer.from(opts.stderr));
    proc.emit('close', opts.code ?? 0);
  });
  return proc as unknown as ChildProcessWithoutNullStreams;
}

function searchN0() {
  return fakeProc({ code: 0, stdout: '', stderr: '' });
}

function searchN1(value = VALUE, account = ACCOUNT) {
  return fakeProc({
    code: 0,
    stdout: `[/1]\nlabel = mat-env-secret-test\nsecret = ${value}\ncreated = x\nmodified = y\n`,
    stderr: `attribute.account = ${account}\nattribute.service = mat-env-secret-test\n`
  });
}

function searchN2() {
  return fakeProc({
    code: 0,
    stdout:
      '[/1]\nlabel = mat-env-secret-test\nsecret = one\ncreated = x\n' +
      '[/2]\nlabel = mat-env-secret-test\nsecret = two\ncreated = x\n',
    stderr: 'attribute.account = first\nattribute.account = second\n'
  });
}

function findSpawnCallsByArg(action: string) {
  return mockSpawn.mock.calls.filter((call) => (call[1] as string[]).includes(action));
}

function expectNoObservation(text: string, ...forbidden: string[]): void {
  for (const value of forbidden) {
    expect(text).not.toContain(value);
  }
}

async function expectEnvSecretError(promise: Promise<unknown>, code: string, ...forbidden: string[]): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvSecretError);
  expect((caught as EnvSecretError).code).toBe(code);
  expectNoObservation((caught as Error).message, ...forbidden);
}

afterEach(() => {
  mockSpawn.mockReset();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetWarnForTest();
});

describe('Linux Secret Service env-secret backend spike', () => {
  it('stores through Secret Service stdin and returns metadata only', async () => {
    let storeProc: ChildProcessWithoutNullStreams | undefined;
    mockSpawn
      .mockImplementationOnce(() => searchN0())
      .mockImplementationOnce(() => {
        storeProc = fakeProc({ code: 0 });
        return storeProc;
      })
      .mockImplementationOnce(() => searchN1(VALUE));

    const backend = createLssEnvBackend();
    const metadata = await storeEnvSecret(backend, binding, VALUE);

    expect(metadata).toEqual({
      profileName: 'work',
      cliId: 'synthetic-cli',
      envName: 'MAT_TEST_SECRET',
      backendKind: 'linux-secret-service',
      backendHandle: 'mat-env-secret-test',
      accountKey: ACCOUNT
    });
    const [storeCall] = findSpawnCallsByArg('store');
    expect((storeCall[1] as string[]).join(' ')).not.toContain(VALUE);
    expect((storeProc as unknown as { stdin: FakeStdin }).stdin.writes.join('')).toContain(VALUE);
    expectNoObservation(JSON.stringify(metadata), VALUE, UPDATED, RAW_OUTPUT);
  });

  it('loads values internally but keeps metadata and list output value-free for known bindings only', async () => {
    mockSpawn
      .mockImplementationOnce(() => searchN1(UPDATED))
      .mockImplementationOnce(() => searchN1(UPDATED))
      .mockImplementationOnce(() => searchN1(UPDATED));

    const backend = createLssEnvBackend({ knownBindings: [binding] });

    await expect(loadEnvSecret(backend, binding)).resolves.toBe(UPDATED);
    await expect(getEnvSecretMetadata(backend, binding)).resolves.toMatchObject({ backendKind: 'linux-secret-service' });
    await expect(listEnvSecretMetadata(backend)).resolves.toEqual([expect.objectContaining({ envName: 'MAT_TEST_SECRET' })]);

    const listed = await listEnvSecretMetadata({ ...backend, async listMetadata() { return []; } });
    expect(listed).toEqual([]);
  });

  it('treats missing lookup as missing, not successful proof', async () => {
    mockSpawn.mockImplementationOnce(() => searchN0());
    const backend = createLssEnvBackend();

    await expectEnvSecretError(loadEnvSecret(backend, binding), 'missing-secret', VALUE, RAW_OUTPUT);
  });

  it('strict unavailable backend fails closed without os-keyring fallback warning', async () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockSpawn.mockImplementationOnce(() => fakeProc({ error: spawnError('ENOENT') }));
    const backend = createLssEnvBackend();

    await expectEnvSecretError(getEnvSecretMetadata(backend, binding), 'backend-failed', VALUE, RAW_OUTPUT);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('refuses ambiguous Secret Service entries before mutation', async () => {
    mockSpawn.mockImplementationOnce(() => searchN2());
    const backend = createLssEnvBackend();

    await expectEnvSecretError(storeEnvSecret(backend, binding, VALUE), 'backend-failed', VALUE, 'one', 'two');
    expect(findSpawnCallsByArg('store')).toHaveLength(0);
  });

  it('requires accountKey for Linux Secret Service binding', async () => {
    const backend = createLssEnvBackend();
    await expectEnvSecretError(
      storeEnvSecret(backend, { ...binding, accountKey: undefined }, VALUE),
      'backend-failed',
      VALUE,
      ACCOUNT
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('delete is idempotent for missing entries and cleanup failures fail closed', async () => {
    const backend = createLssEnvBackend();

    mockSpawn.mockImplementationOnce(() => searchN0());
    await expect(deleteEnvSecret(backend, binding)).resolves.toMatchObject({ operation: 'delete', outcome: 'ok' });

    mockSpawn
      .mockImplementationOnce(() => searchN1(VALUE))
      .mockImplementationOnce(() => fakeProc({ code: 1, stderr: RAW_OUTPUT }));
    await expectEnvSecretError(deleteEnvSecret(backend, binding), 'backend-failed', VALUE, RAW_OUTPUT);
  });

  it('proof report is metadata-only and omits raw account labels by default', () => {
    const report = lssProofReport({
      binding,
      operations: [
        { phase: 'availability', outcome: 'pass', reason: 'ok' },
        { phase: 'delete', outcome: 'refused', reason: 'cleanup-failed' }
      ],
      cleanup: 'required'
    });

    expect(report).toMatchObject({
      backendFamily: 'platform-native credential store',
      backendPlatform: 'linux-secret-service',
      productSurface: 'internal spike only',
      publicParserStatus: 'closed',
      productSupportStatus: 'blocked',
      accountBinding: 'supplied',
      cleanup: 'required'
    });
    expectNoObservation(JSON.stringify(report), VALUE, UPDATED, ACCOUNT, RAW_OUTPUT, 'child command output');
  });

  it('classifies backend proof reasons and cleanup result categories without raw output', () => {
    expect(classifyLssError(new EnvSecretError('missing-secret', 'missing'))).toBe('missing');
    expect(classifyLssError(new EnvSecretError('invalid-binding', 'blocked'))).toBe('blocked');
    expect(classifyLssError(spawnError('ENOENT'))).toBe('unavailable');
    expect(classifyLssError(spawnError('EACCES'))).toBe('denied-or-locked');
    expect(deleteResultToCleanupStatus('deleted')).toBe('complete');
    expect(deleteResultToCleanupStatus('missing')).toBe('missing');
  });
});
