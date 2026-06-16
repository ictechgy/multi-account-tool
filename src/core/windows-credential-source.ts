import {
  WindowsCredentialError,
  readWindowsCredentialSerializedWithAccountGuard,
  validateWindowsCredentialBinding,
  writeWindowsCredentialSerializedWithAccountGuard,
  windowsCredentialExists,
  type WindowsCredentialBinding,
  type WindowsCredentialOperationOptions
} from './windows-credential-manager.js';
import type { Source, WindowsCredentialSource } from './types.js';

export type WindowsCredentialSourceOperation =
  | 'read-source'
  | 'write-source'
  | 'source-exists'
  | 'detector'
  | 'freshness'
  | 'doctor'
  | 'support';

export interface WindowsCredentialSourceSafeMetadata {
  type: 'win-credential';
  saveAs: string;
  credentialType: 'generic';
  reason: 'unsupported-win-credential-source';
}

export function isWindowsCredentialSource(src: Source): src is WindowsCredentialSource {
  return src.type === 'win-credential';
}

export function isWindowsCredentialRuntimeUnsupported(src: Source): boolean {
  return isWindowsCredentialSource(src) && process.platform !== 'win32';
}

export function windowsCredentialSourceMetadata(src: WindowsCredentialSource): WindowsCredentialSourceSafeMetadata {
  return {
    type: 'win-credential',
    saveAs: src.saveAs,
    credentialType: 'generic',
    reason: 'unsupported-win-credential-source'
  };
}

export function unsupportedWindowsCredentialSource(
  src: WindowsCredentialSource,
  operation: WindowsCredentialSourceOperation
): WindowsCredentialError {
  const meta = windowsCredentialSourceMetadata(src);
  return new WindowsCredentialError(
    'unsupported-platform',
    `win-credential source requires win32 runtime; ${operation} is blocked for ${meta.saveAs}/${meta.credentialType}`
  );
}

export function windowsCredentialBindingFromSource(src: WindowsCredentialSource): WindowsCredentialBinding {
  return validateWindowsCredentialBinding({
    targetName: src.targetName,
    credentialType: src.credentialType,
    account: src.account,
    persist: src.persist
  });
}

export async function readWindowsCredentialSourceSerialized(
  src: WindowsCredentialSource,
  options: WindowsCredentialOperationOptions = {}
): Promise<string | null> {
  if (process.platform !== 'win32') throw unsupportedWindowsCredentialSource(src, 'read-source');
  const binding = windowsCredentialBindingFromSource(src);
  return readWindowsCredentialSerializedWithAccountGuard(binding, options);
}

export async function writeWindowsCredentialSourceSerialized(
  src: WindowsCredentialSource,
  serialized: string,
  options: WindowsCredentialOperationOptions = {}
): Promise<void> {
  if (process.platform !== 'win32') throw unsupportedWindowsCredentialSource(src, 'write-source');
  const binding = windowsCredentialBindingFromSource(src);
  await writeWindowsCredentialSerializedWithAccountGuard(binding, serialized, options);
}

export async function windowsCredentialSourceExists(
  src: WindowsCredentialSource,
  options: WindowsCredentialOperationOptions = {}
): Promise<boolean> {
  if (process.platform !== 'win32') throw unsupportedWindowsCredentialSource(src, 'source-exists');
  return windowsCredentialExists(windowsCredentialBindingFromSource(src), options);
}
