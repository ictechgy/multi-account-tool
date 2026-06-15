import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EnvSecretError,
  assertNoDuplicateEnvNames,
  createSyntheticEnvSecretBackend,
  deleteEnvSecret,
  envSecretRefusal,
  eventForBinding,
  findEnvNameConflicts,
  getEnvSecretMetadata,
  listEnvSecretMetadata,
  loadEnvSecret,
  metadataForBinding,
  metadataListForBindings,
  prepareEnvSecretChildEnv,
  storeEnvSecret,
  updateEnvSecret,
  validateEnvSecretDraft,
  validateEnvSecretDrafts,
  validateEnvSecretBinding,
  type EnvSecretBackend,
  type EnvSecretBinding,
  type EnvSecretDraft,
  type EnvSecretMetadata
} from '../../src/core/env-secret.js';
import { validateCliDefRaw } from '../../src/core/cli-defs-plugin.js';

const SENTINEL = 'ENV_SECRET_SENTINEL_VALUE_DO_NOT_LEAK_20260615';
const UPDATED_SENTINEL = 'ENV_SECRET_SENTINEL_UPDATED_VALUE_DO_NOT_LEAK_20260615';

const binding: EnvSecretBinding = {
  profileName: 'work',
  cliId: 'synthetic-cli',
  envName: 'MAT_TEST_SECRET',
  backend: { kind: 'synthetic', handle: 'work-handle' },
  accountKey: 'synthetic-account'
};

const draft: EnvSecretDraft = {
  type: 'env-secret',
  envName: 'MAT_TEST_SECRET',
  saveAs: 'safe.json',
  backend: { kind: 'synthetic', handle: 'work-handle' },
  accountKey: 'synthetic-account'
};

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function assertNoObservedValue(text: string, ...values: string[]): void {
  for (const value of values) {
    if (text.includes(value)) {
      throw new Error('observed forbidden env-secret value');
    }
  }
}

async function expectSuccessful<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch {
    throw new Error('expected env-secret operation to succeed');
  }
}

function expectSuccessfulSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch {
    throw new Error('expected env-secret operation to succeed');
  }
}

async function expectSanitizedRejection(
  promise: Promise<unknown>,
  code: string,
  ...values: string[]
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }

  if (!caught) {
    throw new Error('expected env-secret operation to fail');
  }
  if (!(caught instanceof EnvSecretError)) {
    throw new Error('expected sanitized EnvSecretError');
  }
  if (caught.code !== code) {
    throw new Error(`expected env-secret error code ${code}`);
  }
  assertNoObservedValue(caught.message, ...values);
}

function expectSanitizedThrow(fn: () => unknown, code: string, ...values: string[]): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }

  if (!caught) {
    throw new Error('expected env-secret operation to fail');
  }
  if (!(caught instanceof EnvSecretError)) {
    throw new Error('expected sanitized EnvSecretError');
  }
  if (caught.code !== code) {
    throw new Error(`expected env-secret error code ${code}`);
  }
  assertNoObservedValue(caught.message, ...values);
}

describe('env-secret core', () => {
  it('validates bindings and exposes metadata without values', () => {
    const valid = validateEnvSecretBinding(binding);
    expect(valid).toEqual(binding);

    const metadata = metadataForBinding(binding);
    expect(metadata).toEqual({
      profileName: 'work',
      cliId: 'synthetic-cli',
      envName: 'MAT_TEST_SECRET',
      backendKind: 'synthetic',
      backendHandle: 'work-handle',
      accountKey: 'synthetic-account'
    });
    assertNoObservedValue(JSON.stringify(metadata), SENTINEL);

    const event = eventForBinding(binding, 'store', 'ok');
    expect(event).toEqual({
      phase: 'runtime',
      operation: 'store',
      outcome: 'ok',
      profileName: 'work',
      cliId: 'synthetic-cli',
      envName: 'MAT_TEST_SECRET',
      backendKind: 'synthetic'
    });
    assertNoObservedValue(JSON.stringify(event), SENTINEL);
  });

  it('rejects invalid env names and unsupported backend references fail closed', () => {
    for (const envName of ['', '1BAD', 'BAD-NAME', 'BAD NAME', 'BAD\u0000NAME', `A${'B'.repeat(128)}`]) {
      expect(() => validateEnvSecretBinding({ ...binding, envName })).toThrow(EnvSecretError);
    }

    expect(() => validateEnvSecretBinding({ ...binding, backend: { kind: 'platform', handle: 'x' } as never })).toThrow(
      /unsupported/
    );
  });

  it('detects duplicate env names with platform-specific case handling', () => {
    expect(() => assertNoDuplicateEnvNames(['TOKEN', 'token'], 'linux')).not.toThrow();
    expect(() => assertNoDuplicateEnvNames(['TOKEN', 'token'], 'darwin')).not.toThrow();
    expect(() => assertNoDuplicateEnvNames(['TOKEN', 'token'], 'win32')).toThrow(EnvSecretError);
  });

  it('validates internal draft metadata without public parser acceptance', () => {
    const valid = validateEnvSecretDraft(draft);

    expect(valid).toEqual(draft);
    assertNoObservedValue(JSON.stringify(valid), SENTINEL);
  });

  it('rejects unsafe internal draft fields without echoing field data', () => {
    const secretLikeKey = 'A'.repeat(40);
    for (const envName of ['', '1BAD', 'BAD-NAME']) {
      expectSanitizedThrow(() => validateEnvSecretDraft({ ...draft, envName }), 'invalid-env-name');
    }

    expectSanitizedThrow(
      () => validateEnvSecretDraft({ ...draft, saveAs: 'bad\u202E.json' }),
      'invalid-binding'
    );
    expectSanitizedThrow(
      () => validateEnvSecretDraft({ ...draft, backend: { kind: 'synthetic', handle: 'bad\u202Ehandle' } }),
      'invalid-binding'
    );
    expectSanitizedThrow(
      () => validateEnvSecretDraft({ ...draft, backend: { kind: 'platform', handle: 'safe-handle' } }),
      'unsupported-backend'
    );

    for (const field of ['value', 'default', 'fromEnv', 'env', 'path', 'plainText']) {
      expectSanitizedThrow(
        () => validateEnvSecretDraft({ ...draft, [field]: 'field-data' }),
        'prohibited-source-field',
        'field-data'
      );
    }

    expectSanitizedThrow(
      () => validateEnvSecretDraft({ ...draft, [secretLikeKey]: 'field-data' }),
      'invalid-source-draft',
      secretLikeKey,
      'field-data'
    );
  });

  it('rejects duplicate internal draft identities with platform-specific env handling', () => {
    const secretLikeSaveAs = 'A'.repeat(40);

    expectSanitizedThrow(
      () =>
        validateEnvSecretDrafts([
          { ...draft, saveAs: secretLikeSaveAs },
          { ...draft, saveAs: secretLikeSaveAs, envName: 'OTHER_SECRET' }
        ]),
      'duplicate-save-as',
      secretLikeSaveAs
    );

    expectSanitizedThrow(
      () =>
        validateEnvSecretDrafts([
          draft,
          { ...draft, saveAs: 'other.json', envName: 'mat_test_secret' }
        ], { platform: 'win32' }),
      'duplicate-env-name',
      'MAT_TEST_SECRET',
      'mat_test_secret'
    );

    expect(() =>
      validateEnvSecretDrafts([
        draft,
        { ...draft, envName: 'OTHER_SECRET' }
      ])
    ).toThrow(EnvSecretError);

    expect(() =>
      validateEnvSecretDrafts([
        draft,
        { ...draft, saveAs: 'other.json', envName: 'mat_test_secret' }
      ], { platform: 'linux' })
    ).not.toThrow();
  });

  it('builds metadata-only refusal for unsupported draft routing', () => {
    const refusal = envSecretRefusal(draft, { cliId: 'synthetic-cli', profileName: 'work' });
    const secretLikeAccount = 'A'.repeat(40);
    const refusalWithAccount = envSecretRefusal({ ...draft, accountKey: secretLikeAccount }, { cliId: 'synthetic-cli' });

    expect(refusal).toEqual({
      code: 'unsupported-env-secret-source',
      detail: 'env-secret parser/runtime support is not enabled',
      metadata: {
        saveAs: 'safe.json',
        envName: 'MAT_TEST_SECRET',
        backendKind: 'synthetic',
        cliId: 'synthetic-cli',
        profileName: 'work'
      }
    });
    assertNoObservedValue(JSON.stringify(refusal), SENTINEL, 'work-handle');
    assertNoObservedValue(JSON.stringify(refusalWithAccount), secretLikeAccount, 'work-handle');
  });

  it('runs synthetic store/load/update/delete lifecycle without exporting values', async () => {
    const backend = createSyntheticEnvSecretBackend();

    expect(await expectSuccessful(storeEnvSecret(backend, binding, SENTINEL))).toEqual(metadataForBinding(binding));
    await expect(getEnvSecretMetadata(backend, binding)).resolves.toEqual(metadataForBinding(binding));
    await expect(listEnvSecretMetadata(backend)).resolves.toEqual([metadataForBinding(binding)]);
    expect(await expectSuccessful(updateEnvSecret(backend, binding, UPDATED_SENTINEL))).toEqual(metadataForBinding(binding));
    const loaded = await expectSuccessful(loadEnvSecret(backend, binding));
    assertCondition(loaded === UPDATED_SENTINEL, 'expected updated synthetic value to load');

    const listed = await listEnvSecretMetadata(backend);
    assertNoObservedValue(JSON.stringify(listed), SENTINEL, UPDATED_SENTINEL);

    await expect(deleteEnvSecret(backend, binding)).resolves.toMatchObject({ operation: 'delete', outcome: 'ok' });
    await expect(deleteEnvSecret(backend, binding)).resolves.toMatchObject({ operation: 'delete', outcome: 'ok' });
    await expect(getEnvSecretMetadata(backend, binding)).resolves.toBeNull();
  });

  it('fails closed for missing values without leaking a previous or requested value', async () => {
    const backend = createSyntheticEnvSecretBackend();
    await expectSanitizedRejection(updateEnvSecret(backend, binding, SENTINEL), 'missing-secret', SENTINEL);
  });

  it('wraps backend failures without exposing backend error text or values', async () => {
    const failingBackend: EnvSecretBackend = {
      kind: 'synthetic',
      async store() {
        throw new Error(`raw backend failure ${SENTINEL}`);
      },
      async load() {
        throw new Error(`raw backend failure ${SENTINEL}`);
      },
      async update() {
        throw new Error(`raw backend failure ${SENTINEL}`);
      },
      async delete() {
        throw new Error(`raw backend failure ${SENTINEL}`);
      },
      async metadata() {
        throw new Error(`raw backend failure ${SENTINEL}`);
      },
      async listMetadata() {
        throw new Error(`raw backend failure ${SENTINEL}`);
      }
    };

    for (const operation of [
      () => storeEnvSecret(failingBackend, binding, SENTINEL),
      () => loadEnvSecret(failingBackend, binding),
      () => getEnvSecretMetadata(failingBackend, binding),
      () => listEnvSecretMetadata(failingBackend),
      () => deleteEnvSecret(failingBackend, binding)
    ]) {
      await expectSanitizedRejection(operation(), 'backend-failed', SENTINEL, 'raw backend failure');
    }
  });

  it('prepares child env without mutating parent and without putting values in events', () => {
    const parentEnv = { PATH: '/bin', OTHER: 'kept' };
    const result = expectSuccessfulSync(() =>
      prepareEnvSecretChildEnv({ binding, value: SENTINEL, parentEnv, conflictPolicy: 'hard-stop' })
    );

    expect(Object.keys(result.env).sort()).toEqual(['MAT_TEST_SECRET', 'OTHER', 'PATH']);
    expect(result.env.PATH).toBe('/bin');
    expect(result.env.OTHER).toBe('kept');
    assertCondition(result.env.MAT_TEST_SECRET === SENTINEL, 'expected child env to receive selected value');
    expect(parentEnv).toEqual({ PATH: '/bin', OTHER: 'kept' });
    assertNoObservedValue(JSON.stringify(result.event), SENTINEL);
  });

  it('hard-stops or scrubs inherited env conflicts without leaking inherited values', () => {
    const parentEnv = { PATH: '/bin', mat_test_secret: SENTINEL, MAT_TEST_SECRET: UPDATED_SENTINEL };

    const hardStop = () => prepareEnvSecretChildEnv({ binding, value: 'replacement', parentEnv, conflictPolicy: 'hard-stop', platform: 'win32' });
    expectSanitizedThrow(hardStop, 'ambient-conflict', SENTINEL, UPDATED_SENTINEL);

    expect(findEnvNameConflicts(parentEnv, 'MAT_TEST_SECRET', 'win32').sort()).toEqual(['MAT_TEST_SECRET', 'mat_test_secret']);
    expect(findEnvNameConflicts(parentEnv, 'MAT_TEST_SECRET', 'linux')).toEqual(['MAT_TEST_SECRET']);

    const scrubbed = expectSuccessfulSync(() =>
      prepareEnvSecretChildEnv({ binding, value: 'replacement', parentEnv, conflictPolicy: 'scrub', platform: 'win32' })
    );
    expect(Object.keys(scrubbed.env).sort()).toEqual(['MAT_TEST_SECRET', 'PATH']);
    expect(scrubbed.env.PATH).toBe('/bin');
    assertCondition(scrubbed.env.MAT_TEST_SECRET === 'replacement', 'expected child env to receive replacement value');
    expect(parentEnv.PATH).toBe('/bin');
    assertCondition(parentEnv.mat_test_secret === SENTINEL, 'expected parent env lowercase conflict to remain unchanged');
    assertCondition(parentEnv.MAT_TEST_SECRET === UPDATED_SENTINEL, 'expected parent env uppercase conflict to remain unchanged');
    assertNoObservedValue(JSON.stringify(scrubbed.event), 'replacement');
  });

  it('sanitizes metadata listing output to metadata-only fields', async () => {
    const leakyBackend: EnvSecretBackend = {
      kind: 'synthetic',
      async store() {},
      async load() { return SENTINEL; },
      async update() {},
      async delete() {},
      async metadata() {
        return { ...metadataForBinding(binding), value: SENTINEL } as EnvSecretMetadata;
      },
      async listMetadata() {
        return [{ ...metadataForBinding(binding), value: SENTINEL } as EnvSecretMetadata];
      }
    };

    await expect(getEnvSecretMetadata(leakyBackend, binding)).resolves.toEqual(metadataForBinding(binding));
    await expect(listEnvSecretMetadata(leakyBackend)).resolves.toEqual([metadataForBinding(binding)]);
    assertNoObservedValue(JSON.stringify(metadataListForBindings([binding])), SENTINEL);
  });

  it('keeps plugin schema rejecting env-secret declarations', () => {
    const result = validateCliDefRaw({
      id: 'synthetic-env-secret-cli',
      name: 'Synthetic Env Secret CLI',
      sources: [{ ...draft, saveAs: 'plugin.json' }]
    });

    expect(result.def).toBeUndefined();
    expect(result.error).toContain('env-secret');
    expect(result.error).toContain('parser/runtime');
    expect(result.error).not.toContain('work-handle');
  });

  it('keeps env-secret module outside existing product wiring boundaries', async () => {
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const boundaryFiles = [
      'src/core/sources.ts',
      'src/core/switcher.ts',
      'src/core/exec.ts',
      'src/core/session.ts',
      'src/core/session-cli.ts',
      'src/cli.tsx',
      'src/app.tsx',
      'src/core/cli-defs.ts'
    ];

    for (const file of boundaryFiles) {
      const text = await fs.readFile(`${root}${file}`, 'utf8');
      expect(text).not.toMatch(/env-secret|envSecret|EnvSecret/);
    }

    const envSecretText = await fs.readFile(`${root}src/core/env-secret.ts`, 'utf8');
    expect(envSecretText).not.toMatch(/\b(readSource|writeSource|writeProfileFile|stageProfileFile|keychain|osKeyring|secret-tool|security)\b/);
  });
});
