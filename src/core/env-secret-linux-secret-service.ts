import {
  EnvSecretError,
  metadataForBinding,
  validateEnvSecretBinding,
  validateEnvSecretValue,
  type EnvSecretBackend,
  type EnvSecretBinding,
  type EnvSecretMetadata
} from './env-secret.js';
import { OsKeyringAccountMissingError } from './errors.js';
import {
  deleteOsKeyringSerializedStrict,
  osKeyringExistsStrict,
  readOsKeyringSerializedStrict,
  writeOsKeyringSerializedStrict,
  type OsKeyringDeleteResult
} from './os-keyring.js';
import type { KeychainStored, OsKeyringSource } from './types.js';

const BACKEND_KIND = 'linux-secret-service' as const;
const PROOF_BACKEND_FAMILY = 'platform-native credential store';
const PROOF_PRODUCT_SURFACE = 'internal spike only';
const PROOF_PUBLIC_PARSER_STATUS = 'closed';
const PROOF_PRODUCT_SUPPORT_STATUS = 'blocked';
const INTERNAL_SAVE_AS = 'env-secret.json';

export type LssProofPhase =
  | 'availability'
  | 'create'
  | 'lookup'
  | 'update'
  | 'delete'
  | 'cleanup';

export type LssProofOutcome = 'pass' | 'refused' | 'not-run';

export type LssProofReason =
  | 'ok'
  | 'missing'
  | 'unavailable'
  | 'denied-or-locked'
  | 'ambiguous'
  | 'cleanup-failed'
  | 'backend-failed'
  | 'blocked'
  | 'not-run';

export type LssAccountStatus = 'supplied' | 'missing' | 'blocked';
export type LssCleanupStatus = 'complete' | 'missing' | 'required' | 'not-run';

export interface LssProofOp {
  phase: LssProofPhase;
  outcome: LssProofOutcome;
  reason: LssProofReason;
}

export interface LssProofReport {
  backendFamily: typeof PROOF_BACKEND_FAMILY;
  backendPlatform: typeof BACKEND_KIND;
  productSurface: typeof PROOF_PRODUCT_SURFACE;
  profileName: string;
  cliId: string;
  envName: string;
  backendHandle: string;
  accountBinding: LssAccountStatus;
  operations: LssProofOp[];
  cleanup: LssCleanupStatus;
  publicParserStatus: typeof PROOF_PUBLIC_PARSER_STATUS;
  productSupportStatus: typeof PROOF_PRODUCT_SUPPORT_STATUS;
}

export interface LssProofReportOptions {
  binding: EnvSecretBinding;
  operations: LssProofOp[];
  cleanup?: LssCleanupStatus;
}

export interface LssBackendOptions {
  knownBindings?: EnvSecretBinding[];
}

type LssBinding = EnvSecretBinding & {
  backend: { kind: typeof BACKEND_KIND; handle: string };
  accountKey: string;
};

export function createLssEnvBackend(
  options: LssBackendOptions = {}
): EnvSecretBackend {
  const knownBindings = new Map<string, LssBinding>();
  for (const binding of options.knownBindings ?? []) {
    const valid = validateLssBinding(binding);
    knownBindings.set(bindingKey(valid), valid);
  }

  const remember = (binding: EnvSecretBinding): LssBinding => {
    const valid = validateLssBinding(binding);
    knownBindings.set(bindingKey(valid), valid);
    return valid;
  };

  return {
    kind: BACKEND_KIND,
    async store(binding, value) {
      const valid = validateLssBinding(binding);
      await withBackendFailure(() =>
        writeOsKeyringSerializedStrict(toOsKeyringSource(valid), serializeStoredSecret(valid, value))
      );
      knownBindings.set(bindingKey(valid), valid);
    },
    async load(binding) {
      const valid = validateLssBinding(binding);
      const serialized = await withBackendFailure(() => readOsKeyringSerializedStrict(toOsKeyringSource(valid)));
      if (serialized == null) return null;
      return parseStoredSecret(serialized);
    },
    async update(binding, value) {
      const valid = remember(binding);
      const exists = await withBackendFailure(() => osKeyringExistsStrict(toOsKeyringSource(valid)));
      if (!exists) {
        throw new EnvSecretError('missing-secret', 'profile-owned env-secret is missing');
      }
      await withBackendFailure(() =>
        writeOsKeyringSerializedStrict(toOsKeyringSource(valid), serializeStoredSecret(valid, value))
      );
    },
    async delete(binding) {
      const valid = validateLssBinding(binding);
      await withBackendFailure(() => deleteOsKeyringSerializedStrict(toOsKeyringSource(valid)));
      knownBindings.delete(bindingKey(valid));
    },
    async metadata(binding) {
      const valid = validateLssBinding(binding);
      const exists = await withBackendFailure(() => osKeyringExistsStrict(toOsKeyringSource(valid)));
      return exists ? metadataForBinding(valid) : null;
    },
    async listMetadata() {
      const listed: EnvSecretMetadata[] = [];
      for (const binding of knownBindings.values()) {
        if (await withBackendFailure(() => osKeyringExistsStrict(toOsKeyringSource(binding)))) {
          listed.push(metadataForBinding(binding));
        }
      }
      return listed;
    }
  };
}

export function lssProofReport(
  options: LssProofReportOptions
): LssProofReport {
  const binding = validateEnvSecretBinding(options.binding);
  const accountBinding: LssAccountStatus = binding.accountKey ? 'supplied' : 'missing';
  return {
    backendFamily: PROOF_BACKEND_FAMILY,
    backendPlatform: BACKEND_KIND,
    productSurface: PROOF_PRODUCT_SURFACE,
    profileName: binding.profileName,
    cliId: binding.cliId,
    envName: binding.envName,
    backendHandle: binding.backend.handle,
    accountBinding,
    operations: options.operations.map(sanitizeProofOp),
    cleanup: options.cleanup ?? 'not-run',
    publicParserStatus: PROOF_PUBLIC_PARSER_STATUS,
    productSupportStatus: PROOF_PRODUCT_SUPPORT_STATUS
  };
}

export function classifyLssError(err: unknown): LssProofReason {
  if (err instanceof OsKeyringAccountMissingError) return 'ambiguous';
  if (err instanceof EnvSecretError) {
    if (err.code === 'missing-secret') return 'missing';
    if (err.code === 'invalid-binding' || err.code === 'unsupported-backend') return 'blocked';
    return 'backend-failed';
  }
  const message = err instanceof Error ? err.message : '';
  if (/ENOENT|미설치|부재/.test(message)) return 'unavailable';
  if (/daemon|접근 거부|denied|locked|실행할 수 없습니다|EACCES/i.test(message)) return 'denied-or-locked';
  if (/백업 복구도 실패|cleanup|delete|삭제/i.test(message)) return 'cleanup-failed';
  return 'backend-failed';
}

export function deleteResultToCleanupStatus(result: OsKeyringDeleteResult): LssCleanupStatus {
  return result === 'deleted' ? 'complete' : 'missing';
}

function validateLssBinding(binding: EnvSecretBinding): LssBinding {
  const valid = validateEnvSecretBinding(binding);
  if (valid.backend.kind !== BACKEND_KIND) {
    throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
  }
  if (!valid.accountKey) {
    throw new EnvSecretError('invalid-binding', 'env-secret account binding is required');
  }
  return valid as LssBinding;
}

function toOsKeyringSource(binding: LssBinding): OsKeyringSource {
  return {
    type: 'os-keyring',
    service: binding.backend.handle,
    account: binding.accountKey,
    backend: 'secret-service',
    saveAs: INTERNAL_SAVE_AS
  };
}

function serializeStoredSecret(binding: LssBinding, value: string): string {
  const stored: KeychainStored = {
    value: validateEnvSecretValue(value),
    account: binding.accountKey
  };
  return JSON.stringify(stored);
}

function parseStoredSecret(serialized: string): string {
  try {
    const stored = JSON.parse(serialized) as Partial<KeychainStored>;
    return validateEnvSecretValue(stored.value);
  } catch {
    throw new EnvSecretError('backend-failed', 'env-secret backend payload is invalid');
  }
}

async function withBackendFailure<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (err instanceof EnvSecretError) throw err;
    throw new EnvSecretError('backend-failed', 'env-secret linux secret service backend failed');
  }
}

function sanitizeProofOp(operation: LssProofOp): LssProofOp {
  return {
    phase: operation.phase,
    outcome: operation.outcome,
    reason: operation.reason
  };
}

function bindingKey(binding: LssBinding): string {
  return [binding.profileName, binding.cliId, binding.envName, binding.backend.kind, binding.backend.handle, binding.accountKey]
    .map((part) => `${part.length}:${part}`)
    .join('|');
}
