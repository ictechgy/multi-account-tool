import {
  EnvSecretError,
  validateEnvSecretDraft,
  type EnvSecretBackendKind,
  type EnvSecretDraft
} from './env-secret.js';
import type { EnvSecretSource, Source } from './types.js';

export type EnvSecretSourceOperation =
  | 'read-source'
  | 'write-source'
  | 'source-exists'
  | 'detector'
  | 'freshness'
  | 'doctor'
  | 'exec'
  | 'snapshot'
  | 'restore'
  | 'switch'
  | 'session-start'
  | 'session-run'
  | 'support';

export interface EnvSecretSourceSafeMetadata {
  type: 'env-secret';
  saveAs: string;
  envName: string;
  backendKind: EnvSecretBackendKind;
  reason: 'unsupported-env-secret-source';
}

export function isEnvSecretSource(src: Source): src is EnvSecretSource {
  return src.type === 'env-secret';
}

export function validatePublicEnvSecretSource(input: unknown): EnvSecretSource {
  const draft = validateEnvSecretDraft(input);
  if (draft.backend.kind !== 'linux-secret-service') {
    throw new EnvSecretError('unsupported-backend', 'env-secret backend is unsupported');
  }
  if (!draft.accountKey) {
    throw new EnvSecretError('invalid-binding', 'env-secret account binding is required');
  }
  return publicSourceFromDraft(draft as EnvSecretDraft & {
    backend: { kind: 'linux-secret-service'; handle: string };
    accountKey: string;
  });
}

export function envSecretSourceMetadata(src: EnvSecretSource): EnvSecretSourceSafeMetadata {
  return {
    type: 'env-secret',
    saveAs: src.saveAs,
    envName: src.envName,
    backendKind: src.backend.kind,
    reason: 'unsupported-env-secret-source'
  };
}

export function unsupportedEnvSecretSource(
  src: EnvSecretSource,
  operation: EnvSecretSourceOperation
): EnvSecretError {
  const meta = envSecretSourceMetadata(src);
  return new EnvSecretError(
    'unsupported-env-secret-source',
    `env-secret source is accepted as metadata only; ${operation} is blocked for ${meta.saveAs}/${meta.envName}/${meta.backendKind}`
  );
}

export function assertNoEnvSecretSources(sources: Source[], operation: EnvSecretSourceOperation): void {
  const source = sources.find(isEnvSecretSource);
  if (source) throw unsupportedEnvSecretSource(source, operation);
}

function publicSourceFromDraft(
  draft: EnvSecretDraft & { backend: { kind: 'linux-secret-service'; handle: string }; accountKey: string }
): EnvSecretSource {
  return {
    type: 'env-secret',
    envName: draft.envName,
    saveAs: draft.saveAs,
    backend: {
      kind: draft.backend.kind,
      handle: draft.backend.handle
    },
    accountKey: draft.accountKey
  };
}
