const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const UNSAFE_DISPLAY_RE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

export type EnvSecretBackendKind = 'synthetic';
export type EnvSecretOperation =
  | 'store'
  | 'load'
  | 'update'
  | 'delete'
  | 'metadata'
  | 'list-metadata'
  | 'prepare-child-env';
export type EnvSecretOutcome = 'ok' | 'missing' | 'unsupported' | 'blocked';
export type EnvSecretAuditPhase = 'runtime';
export type EnvSecretConflictPolicy = 'hard-stop' | 'scrub';
export type EnvSecretPlatform = NodeJS.Platform | 'other';
export type EnvSecretErrorCode =
  | 'invalid-binding'
  | 'invalid-env-name'
  | 'duplicate-env-name'
  | 'unsupported-backend'
  | 'missing-secret'
  | 'backend-failed'
  | 'ambient-conflict'
  | 'empty-secret'
  | 'invalid-secret-value';

export interface EnvSecretBackendRef {
  kind: EnvSecretBackendKind;
  handle: string;
}

export interface EnvSecretBinding {
  profileName: string;
  cliId: string;
  envName: string;
  backend: EnvSecretBackendRef;
  accountKey?: string;
}

export interface EnvSecretMetadata {
  profileName: string;
  cliId: string;
  envName: string;
  backendKind: EnvSecretBackendKind;
  backendHandle: string;
  accountKey?: string;
}

export interface EnvSecretAuditEvent {
  phase: EnvSecretAuditPhase;
  operation: EnvSecretOperation;
  outcome: EnvSecretOutcome;
  profileName: string;
  cliId: string;
  envName: string;
  backendKind: EnvSecretBackendKind;
}

export interface EnvSecretBackend {
  readonly kind: EnvSecretBackendKind;
  store(binding: EnvSecretBinding, value: string): Promise<void>;
  load(binding: EnvSecretBinding): Promise<string | null>;
  update(binding: EnvSecretBinding, value: string): Promise<void>;
  delete(binding: EnvSecretBinding): Promise<void>;
  metadata(binding: EnvSecretBinding): Promise<EnvSecretMetadata | null>;
  listMetadata(): Promise<EnvSecretMetadata[]>;
}

export interface PrepareEnvSecretChildEnvOptions {
  binding: EnvSecretBinding;
  value: string;
  parentEnv: Record<string, string | undefined>;
  conflictPolicy: EnvSecretConflictPolicy;
  platform?: EnvSecretPlatform;
}

export interface EnvSecretChildEnvResult {
  env: Record<string, string>;
  event: EnvSecretAuditEvent;
}

export class EnvSecretError extends Error {
  readonly code: EnvSecretErrorCode;

  constructor(code: EnvSecretErrorCode, message: string) {
    super(message);
    this.name = 'EnvSecretError';
    this.code = code;
  }
}

export function validateEnvSecretBinding(input: unknown): EnvSecretBinding {
  if (!input || typeof input !== 'object') {
    throw new EnvSecretError('invalid-binding', 'env-secret binding must be an object');
  }

  const raw = input as Record<string, unknown>;
  const backend = validateBackendRef(raw.backend);
  const binding: EnvSecretBinding = {
    profileName: validateSafeLabel(raw.profileName, 'profile name'),
    cliId: validateSafeLabel(raw.cliId, 'cli id'),
    envName: validateEnvName(raw.envName),
    backend
  };

  if (raw.accountKey !== undefined) {
    binding.accountKey = validateSafeLabel(raw.accountKey, 'account key');
  }

  return binding;
}

export function validateEnvSecretValue(value: unknown): string {
  if (typeof value !== 'string') {
    throw new EnvSecretError('invalid-secret-value', 'env-secret value must be a string');
  }
  if (value.length === 0) {
    throw new EnvSecretError('empty-secret', 'env-secret value is empty');
  }
  if (value.includes('\x00')) {
    throw new EnvSecretError('invalid-secret-value', 'env-secret value contains an unsupported character');
  }
  return value;
}

export function metadataForBinding(binding: EnvSecretBinding): EnvSecretMetadata {
  const valid = validateEnvSecretBinding(binding);
  return {
    profileName: valid.profileName,
    cliId: valid.cliId,
    envName: valid.envName,
    backendKind: valid.backend.kind,
    backendHandle: valid.backend.handle,
    ...(valid.accountKey !== undefined ? { accountKey: valid.accountKey } : {})
  };
}

export function metadataListForBindings(bindings: EnvSecretBinding[]): EnvSecretMetadata[] {
  return bindings.map((binding) => metadataForBinding(binding));
}

export function eventForBinding(
  binding: EnvSecretBinding,
  operation: EnvSecretOperation,
  outcome: EnvSecretOutcome
): EnvSecretAuditEvent {
  const valid = validateEnvSecretBinding(binding);
  return {
    phase: 'runtime',
    operation,
    outcome,
    profileName: valid.profileName,
    cliId: valid.cliId,
    envName: valid.envName,
    backendKind: valid.backend.kind
  };
}

export async function storeEnvSecret(
  backend: EnvSecretBackend,
  binding: EnvSecretBinding,
  value: string
): Promise<EnvSecretMetadata> {
  const valid = validateEnvSecretBinding(binding);
  const secret = validateEnvSecretValue(value);
  ensureBackendMatches(backend, valid);
  try {
    await backend.store(valid, secret);
    const metadata = await backend.metadata(valid);
    if (!metadata) {
      throw new Error('metadata missing after store');
    }
    // Backends may attach implementation-only fields; callers receive only the allowlisted metadata shape.
    return metadataForBinding(valid);
  } catch {
    throw backendFailure('store', valid);
  }
}

export async function loadEnvSecret(backend: EnvSecretBackend, binding: EnvSecretBinding): Promise<string> {
  const valid = validateEnvSecretBinding(binding);
  ensureBackendMatches(backend, valid);
  let value: string | null;
  try {
    value = await backend.load(valid);
  } catch {
    throw backendFailure('load', valid);
  }
  if (value == null) {
    throw new EnvSecretError('missing-secret', `profile-owned env-secret is missing for ${bindingRef(valid)}`);
  }
  return validateEnvSecretValue(value);
}

export async function updateEnvSecret(
  backend: EnvSecretBackend,
  binding: EnvSecretBinding,
  value: string
): Promise<EnvSecretMetadata> {
  const valid = validateEnvSecretBinding(binding);
  const secret = validateEnvSecretValue(value);
  ensureBackendMatches(backend, valid);
  await loadEnvSecret(backend, valid);
  try {
    await backend.update(valid, secret);
    return metadataForBinding(valid);
  } catch {
    throw backendFailure('update', valid);
  }
}

export async function deleteEnvSecret(backend: EnvSecretBackend, binding: EnvSecretBinding): Promise<EnvSecretAuditEvent> {
  const valid = validateEnvSecretBinding(binding);
  ensureBackendMatches(backend, valid);
  try {
    await backend.delete(valid);
  } catch {
    throw backendFailure('delete', valid);
  }
  return eventForBinding(valid, 'delete', 'ok');
}

export async function getEnvSecretMetadata(
  backend: EnvSecretBackend,
  binding: EnvSecretBinding
): Promise<EnvSecretMetadata | null> {
  const valid = validateEnvSecretBinding(binding);
  ensureBackendMatches(backend, valid);
  let metadata: EnvSecretMetadata | null;
  try {
    metadata = await backend.metadata(valid);
  } catch {
    throw backendFailure('metadata', valid);
  }
  return metadata ? metadataForBinding(valid) : null;
}

export async function listEnvSecretMetadata(backend: EnvSecretBackend): Promise<EnvSecretMetadata[]> {
  if (backend.kind !== 'synthetic') {
    throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
  }
  let metadata: EnvSecretMetadata[];
  try {
    metadata = await backend.listMetadata();
  } catch {
    throw new EnvSecretError('backend-failed', 'env-secret list metadata failed');
  }
  return metadata.map((entry) => sanitizeMetadata(entry));
}

export function assertNoDuplicateEnvNames(names: string[], platform: EnvSecretPlatform = process.platform): void {
  const seen = new Map<string, string>();
  for (const name of names) {
    const valid = validateEnvName(name);
    const key = normalizeEnvName(valid, platform);
    const previous = seen.get(key);
    if (previous !== undefined) {
      throw new EnvSecretError('duplicate-env-name', `duplicate environment variable binding: ${previous} conflicts with ${valid}`);
    }
    seen.set(key, valid);
  }
}

export function findEnvNameConflicts(
  parentEnv: Record<string, string | undefined>,
  targetEnvName: string,
  platform: EnvSecretPlatform = process.platform
): string[] {
  const target = validateEnvName(targetEnvName);
  const normalizedTarget = normalizeEnvName(target, platform);
  return Object.keys(parentEnv).filter((name) => normalizeEnvName(name, platform) === normalizedTarget);
}

export function prepareEnvSecretChildEnv(options: PrepareEnvSecretChildEnvOptions): EnvSecretChildEnvResult {
  const binding = validateEnvSecretBinding(options.binding);
  const secret = validateEnvSecretValue(options.value);
  const platform = options.platform ?? process.platform;
  const conflicts = findEnvNameConflicts(options.parentEnv, binding.envName, platform);

  if (conflicts.length > 0 && options.conflictPolicy === 'hard-stop') {
    throw new EnvSecretError('ambient-conflict', `inherited environment conflicts with ${binding.envName}`);
  }

  const env = copyParentEnv(options.parentEnv);
  if (conflicts.length > 0) {
    if (options.conflictPolicy !== 'scrub') {
      throw new EnvSecretError('ambient-conflict', `unsupported conflict policy for ${binding.envName}`);
    }
    for (const name of conflicts) {
      delete env[name];
    }
  }

  env[binding.envName] = secret;
  return {
    env,
    event: eventForBinding(binding, 'prepare-child-env', 'ok')
  };
}

export function createSyntheticEnvSecretBackend(): EnvSecretBackend {
  const values = new Map<string, string>();
  const bindings = new Map<string, EnvSecretBinding>();

  const remember = (binding: EnvSecretBinding): EnvSecretBinding => {
    const valid = validateEnvSecretBinding(binding);
    bindings.set(bindingKey(valid), valid);
    return valid;
  };

  return {
    kind: 'synthetic',
    async store(binding, value) {
      const valid = remember(binding);
      values.set(bindingKey(valid), validateEnvSecretValue(value));
    },
    async load(binding) {
      const valid = validateEnvSecretBinding(binding);
      return values.get(bindingKey(valid)) ?? null;
    },
    async update(binding, value) {
      const valid = remember(binding);
      const key = bindingKey(valid);
      if (!values.has(key)) {
        throw new EnvSecretError('missing-secret', `profile-owned env-secret is missing for ${bindingRef(valid)}`);
      }
      values.set(key, validateEnvSecretValue(value));
    },
    async delete(binding) {
      const valid = validateEnvSecretBinding(binding);
      const key = bindingKey(valid);
      values.delete(key);
      bindings.delete(key);
    },
    async metadata(binding) {
      const valid = validateEnvSecretBinding(binding);
      return values.has(bindingKey(valid)) ? metadataForBinding(valid) : null;
    },
    async listMetadata() {
      return [...bindings.values()]
        .filter((binding) => values.has(bindingKey(binding)))
        .map((binding) => metadataForBinding(binding));
    }
  };
}

function validateBackendRef(input: unknown): EnvSecretBackendRef {
  if (!input || typeof input !== 'object') {
    throw new EnvSecretError('invalid-binding', 'env-secret backend reference must be an object');
  }
  const raw = input as Record<string, unknown>;
  if (raw.kind !== 'synthetic') {
    throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
  }
  return {
    kind: 'synthetic',
    handle: validateSafeLabel(raw.handle, 'backend handle')
  };
}

function validateEnvName(input: unknown): string {
  if (typeof input !== 'string' || !ENV_NAME_RE.test(input)) {
    throw new EnvSecretError('invalid-env-name', 'environment variable name is invalid');
  }
  return input;
}

function validateSafeLabel(input: unknown, fieldName: string): string {
  if (typeof input !== 'string' || input.length === 0 || UNSAFE_DISPLAY_RE.test(input)) {
    throw new EnvSecretError('invalid-binding', `env-secret ${fieldName} is invalid`);
  }
  return input;
}

function ensureBackendMatches(backend: EnvSecretBackend, binding: EnvSecretBinding): void {
  if (!backend || backend.kind !== binding.backend.kind || backend.kind !== 'synthetic') {
    throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
  }
}

function sanitizeMetadata(metadata: EnvSecretMetadata): EnvSecretMetadata {
  return metadataForBinding({
    profileName: metadata.profileName,
    cliId: metadata.cliId,
    envName: metadata.envName,
    backend: {
      kind: metadata.backendKind,
      handle: metadata.backendHandle
    },
    ...(metadata.accountKey !== undefined ? { accountKey: metadata.accountKey } : {})
  });
}

function copyParentEnv(parentEnv: Record<string, string | undefined>): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (typeof value === 'string') {
      copy[name] = value;
    }
  }
  return copy;
}

function normalizeEnvName(name: string, platform: EnvSecretPlatform): string {
  return platform === 'win32' ? name.toUpperCase() : name;
}

function backendFailure(operation: EnvSecretOperation, binding: EnvSecretBinding): EnvSecretError {
  return new EnvSecretError('backend-failed', `env-secret ${operation} failed for ${bindingRef(binding)}`);
}

function bindingRef(binding: EnvSecretBinding): string {
  return `${binding.cliId}/${binding.profileName}/${binding.envName}`;
}

function bindingKey(binding: EnvSecretBinding): string {
  return [binding.profileName, binding.cliId, binding.envName, binding.backend.kind, binding.backend.handle, binding.accountKey ?? '']
    .map((part) => `${part.length}:${part}`)
    .join('|');
}
