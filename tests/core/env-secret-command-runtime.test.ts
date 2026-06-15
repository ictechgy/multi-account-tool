import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { prepareEnvSecretCommandEnv } from '../../src/core/env-secret-command-runtime.js';
import {
  EnvSecretError,
  createSyntheticEnvSecretBackend,
  storeEnvSecret,
  type EnvSecretBackend,
  type EnvSecretBinding
} from '../../src/core/env-secret.js';

const SENTINEL = 'fixture-env-secret-value-not-leaked-20260615';
const AMBIENT_SENTINEL = 'ambient-fixture-env-secret-value-not-leaked-20260615';
const TARGET_ENV = 'MAT_TEST_SECRET';
const UNRELATED_AMBIENT = 'MAT_UNRELATED_AMBIENT_ONLY';

const binding: EnvSecretBinding = {
  profileName: 'work',
  cliId: 'synthetic-runtime-cli',
  envName: TARGET_ENV,
  backend: { kind: 'synthetic', handle: 'runtime-handle' },
  accountKey: 'runtime-account'
};

function assertNoObservedValue(text: string, ...values: string[]): void {
  for (const value of values) {
    if (text.includes(value)) {
      throw new Error('observed forbidden env-secret value');
    }
  }
}

function assertSanitizedEnvSecretError(caught: unknown, code: string, ...values: string[]): void {
  expect(caught).toBeInstanceOf(EnvSecretError);
  expect((caught as EnvSecretError).code).toBe(code);
  const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
  assertNoObservedValue(serialized, ...values, SENTINEL, AMBIENT_SENTINEL, 'runtime-handle', 'runtime-account');
}

async function makeStoredSyntheticBackend(value = SENTINEL): Promise<EnvSecretBackend> {
  const backend = createSyntheticEnvSecretBackend();
  await storeEnvSecret(backend, binding, value);
  return backend;
}

async function runPresenceProbe(env: Record<string, string | undefined>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}> {
  const child = spawn(
    process.execPath,
    ['-e', `process.stdout.write(process.env.${TARGET_ENV} ? 'present' : 'missing')`],
    { shell: false, env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const [code, signal] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  return { code, signal, stdout, stderr };
}

async function expectRejectedEnv(
  promise: Promise<unknown>,
  code: string,
  spawnProbe: ReturnType<typeof vi.fn>,
  ...values: string[]
): Promise<void> {
  let returnedEnv: unknown;
  let caught: unknown;
  try {
    const result = await promise;
    returnedEnv = result;
  } catch (err) {
    caught = err;
  }

  expect(returnedEnv).toBeUndefined();
  expect(spawnProbe).not.toHaveBeenCalled();
  assertSanitizedEnvSecretError(caught, code, ...values);
}

function cloneEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return { ...env };
}

describe('env-secret command runtime — synthetic approval gate', () => {
  it('prepares a constructed child env and proves present/missing with a shell-free synthetic child', async () => {
    const backend = await makeStoredSyntheticBackend();
    const baseEnv = { PATH: process.env.PATH, MAT_BASE_ONLY: 'base-value' };
    const ambientEnv = { PATH: process.env.PATH, [UNRELATED_AMBIENT]: 'ambient-only-value' };
    const baseBefore = cloneEnv(baseEnv);
    const ambientBefore = cloneEnv(ambientEnv);

    const prepared = await prepareEnvSecretCommandEnv({ backend, binding, baseEnv, ambientEnv });

    expect(prepared.env.PATH).toBe(baseEnv.PATH);
    expect(prepared.env.MAT_BASE_ONLY).toBe('base-value');
    expect(prepared.env[UNRELATED_AMBIENT]).toBeUndefined();
    expect(prepared.env[TARGET_ENV]).toBe(SENTINEL);
    expect(baseEnv).toEqual(baseBefore);
    expect(ambientEnv).toEqual(ambientBefore);
    expect(prepared.event).toEqual({
      phase: 'runtime',
      operation: 'prepare-child-env',
      outcome: 'ok',
      profileName: 'work',
      cliId: 'synthetic-runtime-cli',
      envName: TARGET_ENV,
      backendKind: 'synthetic'
    });
    assertNoObservedValue(JSON.stringify(prepared.event), SENTINEL, 'runtime-handle', 'runtime-account');

    const present = await runPresenceProbe(prepared.env);
    expect(present).toMatchObject({ code: 0, signal: null, stdout: 'present', stderr: '' });
    assertNoObservedValue(present.stdout, SENTINEL);
    assertNoObservedValue(present.stderr, SENTINEL);

    const missing = await runPresenceProbe(baseEnv);
    expect(missing).toMatchObject({ code: 0, signal: null, stdout: 'missing', stderr: '' });
    assertNoObservedValue(missing.stdout, SENTINEL);
    assertNoObservedValue(missing.stderr, SENTINEL);
  });

  it('does not read or copy process.env and fails ambient target conflicts before backend load', async () => {
    const previousTarget = process.env[TARGET_ENV];
    const previousUnrelated = process.env[UNRELATED_AMBIENT];
    process.env[TARGET_ENV] = AMBIENT_SENTINEL;
    process.env[UNRELATED_AMBIENT] = 'process-only-unrelated';
    try {
      const backend = await makeStoredSyntheticBackend();
      const loadSpy = vi.fn(backend.load.bind(backend));
      const wrapped: EnvSecretBackend = { ...backend, load: loadSpy };
      const baseEnv = { PATH: process.env.PATH, MAT_BASE_ONLY: 'base-value' };
      const safeAmbientEnv = { PATH: process.env.PATH, [UNRELATED_AMBIENT]: 'ambient-only-value' };
      const conflictAmbientEnv = { ...safeAmbientEnv, [TARGET_ENV]: AMBIENT_SENTINEL };
      const baseBefore = cloneEnv(baseEnv);
      const safeAmbientBefore = cloneEnv(safeAmbientEnv);
      const conflictAmbientBefore = cloneEnv(conflictAmbientEnv);

      const prepared = await prepareEnvSecretCommandEnv({ backend: wrapped, binding, baseEnv, ambientEnv: safeAmbientEnv });
      expect(prepared.env[TARGET_ENV]).toBe(SENTINEL);
      expect(prepared.env[UNRELATED_AMBIENT]).toBeUndefined();
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(baseEnv).toEqual(baseBefore);
      expect(safeAmbientEnv).toEqual(safeAmbientBefore);
      expect(process.env[TARGET_ENV]).toBe(AMBIENT_SENTINEL);
      expect(process.env[UNRELATED_AMBIENT]).toBe('process-only-unrelated');

      await expect(prepareEnvSecretCommandEnv({ backend: wrapped, binding, baseEnv, ambientEnv: conflictAmbientEnv }))
        .rejects.toMatchObject({ code: 'ambient-conflict' });
      expect(loadSpy).toHaveBeenCalledTimes(1);
      expect(conflictAmbientEnv).toEqual(conflictAmbientBefore);
    } finally {
      if (previousTarget === undefined) delete process.env[TARGET_ENV];
      else process.env[TARGET_ENV] = previousTarget;
      if (previousUnrelated === undefined) delete process.env[UNRELATED_AMBIENT];
      else process.env[UNRELATED_AMBIENT] = previousUnrelated;
    }
  });

  it('hard-stops Windows-normalized base env conflicts before backend load', async () => {
    const backend = await makeStoredSyntheticBackend();
    const loadSpy = vi.fn(backend.load.bind(backend));
    const baseEnv = { Path: process.env.PATH, mat_test_secret: 'base-conflict-value' };
    const ambientEnv = { Path: process.env.PATH };
    const baseBefore = cloneEnv(baseEnv);
    const ambientBefore = cloneEnv(ambientEnv);

    await expect(prepareEnvSecretCommandEnv({ backend: { ...backend, load: loadSpy }, binding, baseEnv, ambientEnv, platform: 'win32' }))
      .rejects.toMatchObject({ code: 'ambient-conflict' });

    expect(loadSpy).not.toHaveBeenCalled();
    expect(baseEnv).toEqual(baseBefore);
    expect(ambientEnv).toEqual(ambientBefore);
  });


  it('snapshots base env before async backend load and rejects raw process.env as base env', async () => {
    const backing = await makeStoredSyntheticBackend();
    const baseEnv: Record<string, string | undefined> = { PATH: process.env.PATH, MAT_BASE_ONLY: 'base-value' };
    const ambientEnv = { PATH: process.env.PATH };
    const baseBefore = cloneEnv(baseEnv);
    const ambientBefore = cloneEnv(ambientEnv);
    const mutatingBackend: EnvSecretBackend = {
      ...backing,
      async load(input) {
        baseEnv.MAT_LATE_BASE_ONLY = 'late-base-value';
        baseEnv[TARGET_ENV] = AMBIENT_SENTINEL;
        return backing.load(input);
      }
    };

    const prepared = await prepareEnvSecretCommandEnv({ backend: mutatingBackend, binding, baseEnv, ambientEnv });

    expect(baseBefore).toEqual({ PATH: process.env.PATH, MAT_BASE_ONLY: 'base-value' });
    expect(ambientEnv).toEqual(ambientBefore);
    expect(baseEnv.MAT_LATE_BASE_ONLY).toBe('late-base-value');
    expect(baseEnv[TARGET_ENV]).toBe(AMBIENT_SENTINEL);
    expect(prepared.env.MAT_BASE_ONLY).toBe('base-value');
    expect(prepared.env.MAT_LATE_BASE_ONLY).toBeUndefined();
    expect(prepared.env[TARGET_ENV]).toBe(SENTINEL);
    assertNoObservedValue(JSON.stringify(prepared.event), SENTINEL, AMBIENT_SENTINEL);

    await expect(prepareEnvSecretCommandEnv({ backend: backing, binding, baseEnv: process.env, ambientEnv }))
      .rejects.toMatchObject({ code: 'ambient-conflict' });
  });

  it('rejects negative paths before child spawn and without returning a secret-bearing env', async () => {
    const spawnProbe = vi.fn(runPresenceProbe);
    const baseEnv = { PATH: process.env.PATH };
    const ambientEnv = { PATH: process.env.PATH };

    await expectRejectedEnv(
      prepareEnvSecretCommandEnv({ backend: createSyntheticEnvSecretBackend(), binding, baseEnv, ambientEnv }),
      'missing-secret',
      spawnProbe
    );

    const failingBackend: EnvSecretBackend = {
      kind: 'synthetic',
      async store() {},
      async load() { throw new Error(`raw backend failure ${SENTINEL}`); },
      async update() {},
      async delete() {},
      async metadata() { return null; },
      async listMetadata() { return []; }
    };
    await expectRejectedEnv(
      prepareEnvSecretCommandEnv({ backend: failingBackend, binding, baseEnv, ambientEnv }),
      'backend-failed',
      spawnProbe,
      'raw backend failure'
    );

    const mismatchedBackend: EnvSecretBackend = {
      kind: 'linux-secret-service',
      async store() {},
      async load() { throw new Error('should not load mismatched backend'); },
      async update() {},
      async delete() {},
      async metadata() { return null; },
      async listMetadata() { return []; }
    };
    await expectRejectedEnv(
      prepareEnvSecretCommandEnv({ backend: mismatchedBackend, binding, baseEnv, ambientEnv }),
      'unsupported-backend',
      spawnProbe,
      'should not load mismatched backend'
    );

    const backend = await makeStoredSyntheticBackend();
    await expectRejectedEnv(
      prepareEnvSecretCommandEnv({
        backend,
        binding,
        baseEnv,
        ambientEnv: { ...ambientEnv, [TARGET_ENV]: AMBIENT_SENTINEL }
      }),
      'ambient-conflict',
      spawnProbe,
      AMBIENT_SENTINEL
    );
  });

  it('keeps the command runtime helper synthetic-only and outside product source wiring', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const helperRel = 'src/core/env-secret-command-runtime.ts';
    const helperText = await fs.readFile(join(root, helperRel), 'utf8');
    expect(helperText).not.toContain('createLssEnvBackend');
    expect(helperText).not.toContain('env-secret-linux-secret-service');
    const testText = await fs.readFile(fileURLToPath(import.meta.url), 'utf8');
    expect(testText).not.toMatch(/from ['\"].*env-secret-linux-secret-service/);
    expect(testText).not.toMatch(/createLssEnvBackend\s*\(/);

    const srcRoot = join(root, 'src');
    const sourceFiles = await listSourceFiles(srcRoot);
    for (const file of sourceFiles) {
      const rel = relative(root, file).split(sep).join('/');
      const text = await fs.readFile(file, 'utf8');
      const mentionsRuntimeModule = text.includes('env-secret-command-runtime');
      const mentionsRuntimeHelper = text.includes('prepareEnvSecretCommandEnv');
      if (rel === helperRel) {
        expect(mentionsRuntimeHelper).toBe(true);
        continue;
      }
      expect({ rel, mentionsRuntimeModule, mentionsRuntimeHelper }).toEqual({
        rel,
        mentionsRuntimeModule: false,
        mentionsRuntimeHelper: false
      });
    }
  });
});

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listSourceFiles(abs));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      files.push(abs);
    }
  }
  return files;
}
