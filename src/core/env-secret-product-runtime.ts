import { prepareEnvSecretCommandEnv } from './env-secret-command-runtime.js';
import { createLssEnvBackend } from './env-secret-linux-secret-service.js';
import {
  EnvSecretError,
  assertNoDuplicateEnvNames,
  findEnvNameConflicts,
  validateEnvSecretBinding,
  type EnvSecretAuditEvent,
  type EnvSecretBackend,
  type EnvSecretBinding,
  type EnvSecretPlatform
} from './env-secret.js';
import { isEnvSecretSource, validatePublicEnvSecretSource } from './env-secret-source.js';
import type { Source } from './types.js';

/**
 * Internal pre-command-surface bridge for public env-secret source metadata.
 *
 * This module composes the public `env-secret` schema with the reviewed Linux Secret Service
 * backend and the command-scoped env preparation primitive, but it intentionally does not wire
 * env-secret injection into `mat exec`, `mat session run`, plugins, or any CLI-specific entrypoint.
 */
export type EnvSecretBackendFactory = (bindings: EnvSecretBinding[]) => EnvSecretBackend;

export interface PrepareEnvSecretSourceCommandEnvOptions {
  cliId: string;
  profileName: string;
  source: Source;
  baseEnv: Record<string, string | undefined>;
  ambientEnv: Record<string, string | undefined>;
  platform?: EnvSecretPlatform;
  /** Test seam / future approval gate seam. Product callers should use the default LSS factory. */
  backendFactory?: EnvSecretBackendFactory;
}

export interface PrepareEnvSecretSourcesCommandEnvOptions {
  cliId: string;
  profileName: string;
  sources: readonly Source[];
  baseEnv: Record<string, string | undefined>;
  ambientEnv: Record<string, string | undefined>;
  platform?: EnvSecretPlatform;
  /** Test seam / future approval gate seam. Product callers should use the default LSS factory. */
  backendFactory?: EnvSecretBackendFactory;
}

export interface EnvSecretSourcesCommandEnvResult {
  /** Secret-bearing child environment. Only selected env-secret names may contain secret material. */
  env: Record<string, string>;
  /** Metadata-only command events; no backend handle, account key, proof output, or secret value. */
  events: EnvSecretAuditEvent[];
}

export interface EnvSecretSourceCommandEnvResult {
  /** Secret-bearing child environment. Only selected env-secret names may contain secret material. */
  env: Record<string, string>;
  /** Metadata-only command event; no backend handle, account key, proof output, or secret value. */
  event: EnvSecretAuditEvent;
}

export async function prepareEnvSecretSourceCommandEnv(
  options: PrepareEnvSecretSourceCommandEnvOptions
): Promise<EnvSecretSourceCommandEnvResult> {
  const result = await prepareEnvSecretSourcesCommandEnv({
    cliId: options.cliId,
    profileName: options.profileName,
    sources: [options.source],
    baseEnv: options.baseEnv,
    ambientEnv: options.ambientEnv,
    platform: options.platform,
    backendFactory: options.backendFactory
  });
  const event = result.events[0];
  if (!event) {
    throw new EnvSecretError('invalid-binding', 'env-secret source list is empty');
  }
  return { env: result.env, event };
}

export async function prepareEnvSecretSourcesCommandEnv(
  options: PrepareEnvSecretSourcesCommandEnvOptions
): Promise<EnvSecretSourcesCommandEnvResult> {
  if (options.sources.length === 0) {
    throw new EnvSecretError('invalid-binding', 'env-secret source list is empty');
  }
  if (options.baseEnv === process.env) {
    throw new EnvSecretError('ambient-conflict', 'constructed child environment must not be raw process.env');
  }

  const platform = options.platform ?? process.platform;
  const bindings = options.sources.map((source) => envSecretBindingFromSource(options.cliId, options.profileName, source));
  assertNoDuplicateEnvNames(bindings.map((binding) => binding.envName), platform);

  // Snapshot caller-provided maps before any backend factory/load. A hostile/mutating caller or backend must
  // not be able to add inherited target-env conflicts after preflight and have them copied into the child env.
  const baseEnv = snapshotEnv(options.baseEnv);
  const ambientEnv = snapshotEnv(options.ambientEnv);
  assertNoEnvNameConflicts(bindings, baseEnv, 'constructed', platform);
  assertNoEnvNameConflicts(bindings, ambientEnv, 'inherited', platform);

  const backend = (options.backendFactory ?? defaultEnvSecretBackendFactory)(bindings.map(cloneBinding));
  let env: Record<string, string | undefined> = baseEnv;
  const events: EnvSecretAuditEvent[] = [];

  for (const binding of bindings) {
    const prepared = await prepareEnvSecretCommandEnv({
      backend,
      binding,
      baseEnv: env,
      ambientEnv,
      platform
    });
    env = prepared.env;
    events.push(prepared.event);
  }

  return { env: copyStringEnv(env), events };
}

function envSecretBindingFromSource(cliId: string, profileName: string, source: Source): EnvSecretBinding {
  if (!isEnvSecretSource(source)) {
    throw new EnvSecretError('unsupported-env-secret-source', 'env-secret runtime bridge only accepts env-secret sources');
  }

  const validSource = validatePublicEnvSecretSource(source);
  if (validSource.backend.kind !== 'linux-secret-service') {
    throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
  }
  if (!validSource.accountKey) {
    throw new EnvSecretError('invalid-binding', 'env-secret account binding is required');
  }

  return validateEnvSecretBinding({
    profileName,
    cliId,
    envName: validSource.envName,
    backend: {
      kind: validSource.backend.kind,
      handle: validSource.backend.handle
    },
    accountKey: validSource.accountKey
  });
}

function defaultEnvSecretBackendFactory(bindings: EnvSecretBinding[]): EnvSecretBackend {
  for (const binding of bindings) {
    if (binding.backend.kind !== 'linux-secret-service') {
      throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
    }
  }
  return createLssEnvBackend({ knownBindings: bindings.map(cloneBinding) });
}

function assertNoEnvNameConflicts(
  bindings: EnvSecretBinding[],
  env: Record<string, string | undefined>,
  envKind: 'constructed' | 'inherited',
  platform: EnvSecretPlatform
): void {
  for (const binding of bindings) {
    const conflicts = findEnvNameConflicts(env, binding.envName, platform);
    if (conflicts.length > 0) {
      const prefix = envKind === 'constructed' ? 'constructed child environment' : 'inherited environment';
      throw new EnvSecretError('ambient-conflict', `${prefix} conflicts with ${binding.envName}`);
    }
  }
}

function snapshotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    snapshot[key] = env[key];
  }
  return snapshot;
}

function copyStringEnv(env: Record<string, string | undefined>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') copy[key] = value;
  }
  return copy;
}

function cloneBinding(binding: EnvSecretBinding): EnvSecretBinding {
  return {
    profileName: binding.profileName,
    cliId: binding.cliId,
    envName: binding.envName,
    backend: {
      kind: binding.backend.kind,
      handle: binding.backend.handle
    },
    ...(binding.accountKey !== undefined ? { accountKey: binding.accountKey } : {})
  };
}
