import {
  EnvSecretError,
  findEnvNameConflicts,
  loadEnvSecret,
  prepareEnvSecretChildEnv,
  validateEnvSecretBinding,
  type EnvSecretAuditEvent,
  type EnvSecretBackend,
  type EnvSecretBinding,
  type EnvSecretPlatform
} from './env-secret.js';

/**
 * Options for preparing a command-scoped child environment from a profile-owned env-secret.
 *
 * This is an internal approval-gate primitive only. It does not wire env-secret sources into
 * `mat exec`, `mat session run`, plugins, builtins, or any product command surface.
 */
export interface PrepareEnvSecretCommandEnvOptions {
  /** Backend selected by the caller; this module does not instantiate product custody backends. */
  backend: EnvSecretBackend;
  /** Profile-owned env-secret binding metadata. */
  binding: EnvSecretBinding;
  /** Caller-constructed child environment baseline. This must not be raw `process.env` pass-through. */
  baseEnv: Record<string, string | undefined>;
  /** Parent/ambient environment to check for competing credential-channel variables. Required. */
  ambientEnv: Record<string, string | undefined>;
  platform?: EnvSecretPlatform;
}

export interface EnvSecretCommandEnvResult {
  /** Secret-bearing child environment. Only `env[binding.envName]` may contain secret material. */
  env: Record<string, string>;
  /** Metadata-only runtime event; never includes value, backend handle, or account key. */
  event: EnvSecretAuditEvent;
}

/**
 * Prepare a command-scoped child env for one profile-owned env-secret.
 *
 * Security properties:
 * - inherited/ambient target env-name conflicts fail before the backend is read;
 * - the returned env is built from explicit `baseEnv`, not ambient/process env;
 * - the only secret-bearing output is the returned env entry for the binding env name;
 * - metadata events remain value/handle/account-key free.
 */
export async function prepareEnvSecretCommandEnv(
  options: PrepareEnvSecretCommandEnvOptions
): Promise<EnvSecretCommandEnvResult> {
  if (options.baseEnv === process.env) {
    throw new EnvSecretError('ambient-conflict', 'constructed child environment must not be raw process.env');
  }

  const binding = validateEnvSecretBinding(options.binding);
  const platform = options.platform ?? process.platform;
  // Snapshot caller-provided env maps before any async backend access. Callers may hold mutable env
  // objects; late mutations must not become part of the secret-bearing child env.
  const ambientEnv = snapshotEnv(options.ambientEnv);
  const baseEnv = snapshotEnv(options.baseEnv);

  const ambientConflicts = findEnvNameConflicts(ambientEnv, binding.envName, platform);
  if (ambientConflicts.length > 0) {
    throw new EnvSecretError('ambient-conflict', `inherited environment conflicts with ${binding.envName}`);
  }

  const baseConflicts = findEnvNameConflicts(baseEnv, binding.envName, platform);
  if (baseConflicts.length > 0) {
    throw new EnvSecretError('ambient-conflict', `constructed child environment conflicts with ${binding.envName}`);
  }

  const value = await loadEnvSecret(options.backend, binding);
  return prepareEnvSecretChildEnv({
    binding,
    value,
    parentEnv: baseEnv,
    conflictPolicy: 'hard-stop',
    platform
  });
}

function snapshotEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    snapshot[key] = env[key];
  }
  return snapshot;
}
