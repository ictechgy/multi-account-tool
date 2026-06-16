import { promises as fs } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  prepareEnvSecretSourceCommandEnv,
  prepareEnvSecretSourcesCommandEnv,
  type EnvSecretBackendFactory
} from '../../src/core/env-secret-product-runtime.js';
import {
  EnvSecretError,
  type EnvSecretBackend,
  type EnvSecretBinding,
  type EnvSecretMetadata
} from '../../src/core/env-secret.js';
import type { EnvSecretSource, FileSource } from '../../src/core/types.js';

const SENTINEL = 'fixture-env-secret-product-runtime-value-20260616';
const SECOND_SENTINEL = 'fixture-env-secret-product-runtime-second-20260616';
const RAW_OUTPUT = 'raw backend output with fixture value';
const HANDLE = 'runtime-lss-handle';
const ACCOUNT = 'runtime-lss-account';
const TARGET_ENV = 'MAT_TEST_SECRET';
const SECOND_ENV = 'MAT_SECOND_SECRET';

const source: EnvSecretSource = {
  type: 'env-secret',
  envName: TARGET_ENV,
  saveAs: 'future.json',
  backend: { kind: 'linux-secret-service', handle: HANDLE },
  accountKey: ACCOUNT
};

function assertNoObservedValue(text: string, ...values: string[]): void {
  for (const value of values) {
    expect(text).not.toContain(value);
  }
}

function makeBackend(values: Record<string, string | null> = { [TARGET_ENV]: SENTINEL }): EnvSecretBackend & {
  load: ReturnType<typeof vi.fn>;
  metadata: ReturnType<typeof vi.fn>;
  listMetadata: ReturnType<typeof vi.fn>;
} {
  return {
    kind: 'linux-secret-service',
    async store() {},
    load: vi.fn(async (binding: EnvSecretBinding) => values[binding.envName] ?? null),
    async update() {},
    async delete() {},
    metadata: vi.fn(async (): Promise<EnvSecretMetadata | null> => {
      throw new Error(`metadata must not be called ${RAW_OUTPUT}`);
    }),
    listMetadata: vi.fn(async (): Promise<EnvSecretMetadata[]> => {
      throw new Error(`listMetadata must not be called ${RAW_OUTPUT}`);
    })
  };
}

function makeFactory(backend = makeBackend()): EnvSecretBackendFactory & ReturnType<typeof vi.fn> {
  return vi.fn(() => backend) as EnvSecretBackendFactory & ReturnType<typeof vi.fn>;
}

async function expectEnvSecretRejection(
  promise: Promise<unknown>,
  code: string,
  factory: ReturnType<typeof vi.fn>,
  expectFactoryCalled: boolean,
  ...forbidden: string[]
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(EnvSecretError);
  expect((caught as EnvSecretError).code).toBe(code);
  const serialized = JSON.stringify(caught, Object.getOwnPropertyNames(caught));
  assertNoObservedValue(serialized, SENTINEL, SECOND_SENTINEL, RAW_OUTPUT, HANDLE, ACCOUNT, ...forbidden);
  if (expectFactoryCalled) expect(factory).toHaveBeenCalledOnce();
  else expect(factory).not.toHaveBeenCalled();
}

function withEnvName(envName: string, saveAs = `${envName.toLowerCase()}.json`): EnvSecretSource {
  return { ...source, envName, saveAs };
}

describe('env-secret product runtime bridge — pre-command-surface approval gate', () => {
  it('composes a public LSS env-secret source into a command env using an injected backend factory only', async () => {
    const backend = makeBackend();
    const factory = makeFactory(backend);
    const baseEnv = { PATH: '/bin', MAT_BASE_ONLY: 'base-value' };
    const ambientEnv = { PATH: '/bin', MAT_AMBIENT_ONLY: 'ambient-value' };

    const prepared = await prepareEnvSecretSourceCommandEnv({
      cliId: 'future-env',
      profileName: 'work',
      source,
      baseEnv,
      ambientEnv,
      backendFactory: factory,
      platform: 'linux'
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0][0]).toEqual([{
      profileName: 'work',
      cliId: 'future-env',
      envName: TARGET_ENV,
      backend: { kind: 'linux-secret-service', handle: HANDLE },
      accountKey: ACCOUNT
    }]);
    expect(backend.load).toHaveBeenCalledOnce();
    expect(backend.metadata).not.toHaveBeenCalled();
    expect(backend.listMetadata).not.toHaveBeenCalled();
    expect(prepared.env).toMatchObject({ PATH: '/bin', MAT_BASE_ONLY: 'base-value', [TARGET_ENV]: SENTINEL });
    expect(prepared.env.MAT_AMBIENT_ONLY).toBeUndefined();
    expect(baseEnv).toEqual({ PATH: '/bin', MAT_BASE_ONLY: 'base-value' });
    expect(ambientEnv).toEqual({ PATH: '/bin', MAT_AMBIENT_ONLY: 'ambient-value' });
    expect(prepared.event).toEqual({
      phase: 'runtime',
      operation: 'prepare-child-env',
      outcome: 'ok',
      profileName: 'work',
      cliId: 'future-env',
      envName: TARGET_ENV,
      backendKind: 'linux-secret-service'
    });
    assertNoObservedValue(JSON.stringify(prepared.event), SENTINEL, HANDLE, ACCOUNT, RAW_OUTPUT);
  });

  it('prepares multiple env-secret sources after duplicate and conflict preflight', async () => {
    const backend = makeBackend({ [TARGET_ENV]: SENTINEL, [SECOND_ENV]: SECOND_SENTINEL });
    const factory = makeFactory(backend);

    const prepared = await prepareEnvSecretSourcesCommandEnv({
      cliId: 'future-env',
      profileName: 'work',
      sources: [source, withEnvName(SECOND_ENV, 'second.json')],
      baseEnv: { PATH: '/bin' },
      ambientEnv: { PATH: '/bin' },
      backendFactory: factory,
      platform: 'linux'
    });

    expect(factory).toHaveBeenCalledOnce();
    expect(backend.load).toHaveBeenCalledTimes(2);
    expect(prepared.env[TARGET_ENV]).toBe(SENTINEL);
    expect(prepared.env[SECOND_ENV]).toBe(SECOND_SENTINEL);
    expect(prepared.events.map((event) => event.envName)).toEqual([TARGET_ENV, SECOND_ENV]);
    assertNoObservedValue(JSON.stringify(prepared.events), SENTINEL, SECOND_SENTINEL, HANDLE, ACCOUNT);
  });

  it('rejects duplicate env names with platform-specific normalization before backend factory/load', async () => {
    const backend = makeBackend({ TOKEN: SENTINEL, token: SECOND_SENTINEL });
    const factory = makeFactory(backend);
    const upper = withEnvName('TOKEN', 'upper.json');
    const lower = withEnvName('token', 'lower.json');

    await expectEnvSecretRejection(
      prepareEnvSecretSourcesCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        sources: [upper, lower],
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: factory,
        platform: 'win32'
      }),
      'duplicate-env-name',
      factory,
      false
    );

    const linuxFactory = makeFactory(backend);
    const prepared = await prepareEnvSecretSourcesCommandEnv({
      cliId: 'future-env',
      profileName: 'work',
      sources: [upper, lower],
      baseEnv: { PATH: '/bin' },
      ambientEnv: { PATH: '/bin' },
      backendFactory: linuxFactory,
      platform: 'linux'
    });
    expect(prepared.env.TOKEN).toBe(SENTINEL);
    expect(prepared.env.token).toBe(SECOND_SENTINEL);
  });

  it('rejects ambient/base target conflicts and raw process.env before backend factory/load', async () => {
    const factory = makeFactory();

    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source,
        baseEnv: { PATH: '/bin', MAT_TEST_SECRET: 'base-conflict-value' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: factory,
        platform: 'linux'
      }),
      'ambient-conflict',
      factory,
      false,
      'base-conflict-value'
    );

    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source,
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin', mat_test_secret: 'ambient-conflict-value' },
        backendFactory: factory,
        platform: 'win32'
      }),
      'ambient-conflict',
      factory,
      false,
      'ambient-conflict-value'
    );

    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source,
        baseEnv: process.env,
        ambientEnv: { PATH: '/bin' },
        backendFactory: factory,
        platform: 'linux'
      }),
      'ambient-conflict',
      factory,
      false
    );
  });

  it('fails closed for unsupported or malformed public source metadata before backend factory/load', async () => {
    const factory = makeFactory();
    const fileSource: FileSource = { type: 'file', path: '/tmp/token', saveAs: 'token.json' };

    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source: fileSource,
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: factory
      }),
      'unsupported-env-secret-source',
      factory,
      false,
      '/tmp/token'
    );

    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source: { ...source, accountKey: undefined } as unknown as EnvSecretSource,
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: factory
      }),
      'invalid-binding',
      factory,
      false
    );

    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source: { ...source, backend: { kind: 'synthetic', handle: 'synthetic-handle' } } as unknown as EnvSecretSource,
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: factory
      }),
      'unsupported-backend',
      factory,
      false,
      'synthetic-handle'
    );
  });

  it('sanitizes missing and failing backend loads without metadata/proof calls', async () => {
    const missingBackend = makeBackend({ [TARGET_ENV]: null });
    const missingFactory = makeFactory(missingBackend);
    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source,
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: missingFactory
      }),
      'missing-secret',
      missingFactory,
      true
    );
    expect(missingBackend.metadata).not.toHaveBeenCalled();
    expect(missingBackend.listMetadata).not.toHaveBeenCalled();

    const failingBackend = makeBackend();
    failingBackend.load.mockRejectedValueOnce(new Error(`${RAW_OUTPUT} ${SENTINEL} ${HANDLE} ${ACCOUNT}`));
    const failingFactory = makeFactory(failingBackend);
    await expectEnvSecretRejection(
      prepareEnvSecretSourceCommandEnv({
        cliId: 'future-env',
        profileName: 'work',
        source,
        baseEnv: { PATH: '/bin' },
        ambientEnv: { PATH: '/bin' },
        backendFactory: failingFactory
      }),
      'backend-failed',
      failingFactory,
      true
    );
    expect(failingBackend.metadata).not.toHaveBeenCalled();
    expect(failingBackend.listMetadata).not.toHaveBeenCalled();
  });

  it('keeps the bridge outside product command and Source consumer wiring', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const bridgeRel = 'src/core/env-secret-product-runtime.ts';
    const bridgeText = await fs.readFile(join(root, bridgeRel), 'utf8');
    expect(bridgeText).not.toMatch(/from ['"]node:(child_process|fs|http|https|os|process)['"]/);
    expect(bridgeText).not.toMatch(/\bspawn\s*\(/);
    expect(bridgeText).not.toMatch(/\bmetadata\s*\(|\blistMetadata\s*\(|lssProofReport/);
    expect(bridgeText).not.toMatch(/\bamp\b|\bcopilot\b/i);

    const sourceFiles = await listSourceFiles(join(root, 'src'));
    const bridgeImportRe = /env-secret-product-runtime|prepareEnvSecretSourceCommandEnv|prepareEnvSecretSourcesCommandEnv/;
    const allowedBridgeMentions = new Set([bridgeRel]);
    for (const file of sourceFiles) {
      const rel = relative(root, file).split(sep).join('/');
      const text = await fs.readFile(file, 'utf8');
      if (allowedBridgeMentions.has(rel)) continue;
      expect({ rel, mentionsBridge: bridgeImportRe.test(text) }).toEqual({ rel, mentionsBridge: false });
    }

    const productConsumers = [
      'src/core/sources.ts',
      'src/core/switcher.ts',
      'src/core/freshness.ts',
      'src/core/doctor.ts',
      'src/core/support.ts',
      'src/core/detector.ts',
      'src/core/exec.ts',
      'src/core/session.ts',
      'src/core/cli-defs-plugin.ts',
      'src/cli.tsx',
      'src/app/formatters.ts',
      'src/app/log.ts',
      'src/app/state.ts',
      'src/app/validators.ts'
    ];
    for (const rel of productConsumers) {
      const text = await fs.readFile(join(root, rel), 'utf8');
      expect({ rel, importsBridge: bridgeImportRe.test(text) }).toEqual({ rel, importsBridge: false });
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
