/**
 * Internal Windows Credential Manager backend proof.
 *
 * The public `win-credential` source wrapper lives in windows-credential-source.ts.
 * This module stays the low-level backend bridge: no builtin CLI, Copilot/Amp, or
 * package-level Windows support claim is made here.
 */

import { randomUUID } from 'node:crypto';
import { runCommand } from './run-command.js';
import { hasUnsafeDisplayChar } from './display-safety.js';
import { maskIdentifier, redactMessage } from './errors.js';

export type WindowsCredentialType = 'generic';
export type WindowsCredentialPersist = 'session' | 'local-machine' | 'enterprise';

export interface WindowsCredentialBinding {
  targetName: string;
  credentialType: WindowsCredentialType;
  account?: string;
  persist?: WindowsCredentialPersist;
}

export interface WindowsCredentialStoredV1 {
  schemaVersion: 1;
  targetName: string;
  credentialType: WindowsCredentialType;
  account?: string;
  persist?: WindowsCredentialPersist;
  secret: string;
}

export type WindowsCredentialErrorCode =
  | 'unsupported-platform'
  | 'missing'
  | 'access-denied'
  | 'api-unavailable'
  | 'invalid-input'
  | 'malformed-backup'
  | 'account-mismatch'
  | 'write-failed'
  | 'delete-failed'
  | 'rollback-failed'
  | 'bridge-failed';

export interface WindowsCredentialErrorDetails {
  phase?: string;
  targetHash?: string;
  accountHash?: string;
  credentialType?: WindowsCredentialType;
  win32Code?: number;
  win32Name?: string;
  causeCode?: WindowsCredentialErrorCode;
  rollbackCode?: WindowsCredentialErrorCode;
}

export class WindowsCredentialError extends Error {
  readonly code: WindowsCredentialErrorCode;
  readonly details: WindowsCredentialErrorDetails;

  constructor(code: WindowsCredentialErrorCode, message: string, details: WindowsCredentialErrorDetails = {}) {
    super(redactMessage(message));
    this.name = 'WindowsCredentialError';
    this.code = code;
    this.details = { ...details };
  }
}

export interface WindowsCredentialBridgeReadPresent {
  status: 'present';
  secret: string;
  account?: string;
  persist?: WindowsCredentialPersist;
}

export interface WindowsCredentialBridgeReadMissing {
  status: 'missing';
}

export type WindowsCredentialBridgeReadResult = WindowsCredentialBridgeReadPresent | WindowsCredentialBridgeReadMissing;

export interface WindowsCredentialBridgeInspectPresent {
  status: 'present';
  account?: string;
  persist?: WindowsCredentialPersist;
}

export interface WindowsCredentialBridgeInspectMissing {
  status: 'missing';
}

export type WindowsCredentialBridgeInspectResult =
  | WindowsCredentialBridgeInspectPresent
  | WindowsCredentialBridgeInspectMissing;

export interface WindowsCredentialBridgeWriteRequest extends WindowsCredentialBinding {
  persist: WindowsCredentialPersist;
  secret: string;
}

export interface WindowsCredentialBridge {
  inspect(binding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeInspectResult>;
  read(binding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeReadResult>;
  write(request: WindowsCredentialBridgeWriteRequest): Promise<void>;
  delete(binding: WindowsCredentialBinding): Promise<'deleted' | 'missing'>;
}

export interface WindowsCredentialOperationOptions {
  bridge?: WindowsCredentialBridge;
}

const CRED_MAX_GENERIC_TARGET_NAME_LENGTH = 32_767;
const CRED_MAX_USERNAME_LENGTH = 513;
const CRED_MAX_CREDENTIAL_BLOB_SIZE = 5 * 512;
const DEFAULT_ACCOUNT = 'mat-windows-credential';
const POWERSHELL_EXE = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';

const PERSIST_TO_WIN32: Record<WindowsCredentialPersist, number> = {
  session: 1,
  'local-machine': 2,
  enterprise: 3
};

const WIN32_TO_PERSIST = new Map<number, WindowsCredentialPersist>([
  [1, 'session'],
  [2, 'local-machine'],
  [3, 'enterprise']
]);

export function makeSyntheticWindowsCredentialBinding(caseName: string, runId = process.env.GITHUB_RUN_ID ?? 'local'): WindowsCredentialBinding {
  return validateWindowsCredentialBinding({
    targetName: `mat-test/${runId}/${caseName}/${randomUUID()}`,
    credentialType: 'generic',
    account: 'mat-ci-synthetic',
    persist: 'session'
  });
}

export async function readWindowsCredentialSerialized(
  binding: WindowsCredentialBinding,
  options: WindowsCredentialOperationOptions = {}
): Promise<string | null> {
  const safeBinding = validateWindowsCredentialBinding(binding);
  const bridge = options.bridge ?? defaultWindowsCredentialBridge;
  const result = await readViaBridge(bridge, safeBinding);
  if (result.status === 'missing') return null;
  return JSON.stringify(storedFromReadResult(safeBinding, result));
}

export async function readWindowsCredentialSerializedWithAccountGuard(
  binding: WindowsCredentialBinding,
  options: WindowsCredentialOperationOptions = {}
): Promise<string | null> {
  const safeBinding = validateWindowsCredentialBinding(binding);
  const bridge = options.bridge ?? defaultWindowsCredentialBridge;
  const metadata = await inspectViaBridge(bridge, safeBinding);
  if (metadata.status === 'missing') return null;
  assertAccountMetadataMatches(safeBinding, metadata, 'read-preflight');

  const result = await readViaBridge(bridge, safeBinding);
  if (result.status === 'missing') return null;
  // Race guard: if the target changed between inspect/read, do not return a
  // copied secret whose UserName metadata no longer matches the public guard.
  assertAccountMetadataMatches(safeBinding, result, 'read-postcheck');
  return JSON.stringify(storedFromReadResult(safeBinding, result));
}

export async function writeWindowsCredentialSerialized(
  binding: WindowsCredentialBinding,
  serialized: string,
  options: WindowsCredentialOperationOptions = {}
): Promise<void> {
  const safeBinding = validateWindowsCredentialBinding(binding);
  const stored = parseStoredBackup(serialized, safeBinding);
  const bridge = options.bridge ?? defaultWindowsCredentialBridge;

  const backupRead = await readViaBridge(bridge, safeBinding);
  const backup = backupRead.status === 'present' ? storedFromReadResult(safeBinding, backupRead) : null;

  try {
    await writeViaBridge(bridge, writeRequestFromStored(safeBinding, stored));
  } catch (err) {
    const writeErr = toWindowsCredentialError(err, 'write-failed', safeBinding, 'write');
    if (!backup) throw writeErr;
    try {
      await writeViaBridge(bridge, writeRequestFromStored(safeBinding, backup, 'stored-first'));
    } catch (rollback) {
      const rollbackErr = toWindowsCredentialError(rollback, 'rollback-failed', safeBinding, 'rollback');
      throw new WindowsCredentialError(
        'rollback-failed',
        'windows credential write failed and rollback failed',
        {
          ...safeDetails(safeBinding, 'rollback'),
          causeCode: writeErr.code,
          rollbackCode: rollbackErr.code
        }
      );
    }
    throw writeErr;
  }
}

export async function windowsCredentialExists(
  binding: WindowsCredentialBinding,
  options: WindowsCredentialOperationOptions = {}
): Promise<boolean> {
  const safeBinding = validateWindowsCredentialBinding(binding);
  const bridge = options.bridge ?? defaultWindowsCredentialBridge;
  const result = await inspectViaBridge(bridge, safeBinding);
  if (result.status === 'present') {
    assertAccountMetadataMatches(safeBinding, result, 'inspect');
  }
  return result.status === 'present';
}

export async function inspectWindowsCredential(
  binding: WindowsCredentialBinding,
  options: WindowsCredentialOperationOptions = {}
): Promise<WindowsCredentialBridgeInspectResult> {
  const safeBinding = validateWindowsCredentialBinding(binding);
  const bridge = options.bridge ?? defaultWindowsCredentialBridge;
  const result = await inspectViaBridge(bridge, safeBinding);
  if (result.status === 'present') {
    assertAccountMetadataMatches(safeBinding, result, 'inspect');
  }
  return result;
}

export async function deleteWindowsCredential(
  binding: WindowsCredentialBinding,
  options: WindowsCredentialOperationOptions = {}
): Promise<'deleted' | 'missing'> {
  const safeBinding = validateWindowsCredentialBinding(binding);
  const bridge = options.bridge ?? defaultWindowsCredentialBridge;
  try {
    return await bridge.delete(safeBinding);
  } catch (err) {
    throw toWindowsCredentialError(err, 'delete-failed', safeBinding, 'delete');
  }
}

export function validateWindowsCredentialBinding(binding: WindowsCredentialBinding): WindowsCredentialBinding {
  if (!isPlainObject(binding)) {
    throw new WindowsCredentialError('invalid-input', 'windows credential binding must be an object');
  }
  assertSafeTargetName(binding.targetName);
  if (binding.credentialType !== 'generic') {
    throw new WindowsCredentialError('invalid-input', 'windows credential type must be generic', safeDetails(binding, 'validate'));
  }
  if (binding.account !== undefined) assertSafeAccount(binding.account, binding);
  if (binding.persist !== undefined) assertSafePersist(binding.persist, binding);
  return {
    targetName: binding.targetName,
    credentialType: 'generic',
    ...(binding.account !== undefined ? { account: binding.account } : {}),
    ...(binding.persist !== undefined ? { persist: binding.persist } : {})
  };
}

function parseStoredBackup(serialized: string, binding: WindowsCredentialBinding): WindowsCredentialStoredV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw malformedBackup(binding, 'serialized backup must be valid JSON');
  }
  if (!isPlainObject(parsed)) throw malformedBackup(binding, 'serialized backup must be an object');
  if (parsed.schemaVersion !== 1) throw malformedBackup(binding, 'serialized backup schemaVersion must be 1');
  if (parsed.targetName !== binding.targetName) throw malformedBackup(binding, 'serialized backup targetName does not match binding');
  if (parsed.credentialType !== 'generic') throw malformedBackup(binding, 'serialized backup credentialType must be generic');
  if (typeof parsed.secret !== 'string') throw malformedBackup(binding, 'serialized backup secret must be a string');
  assertSecretSize(parsed.secret, binding);

  const stored: WindowsCredentialStoredV1 = {
    schemaVersion: 1,
    targetName: binding.targetName,
    credentialType: 'generic',
    secret: parsed.secret
  };
  if (parsed.account !== undefined) {
    if (typeof parsed.account !== 'string') throw malformedBackup(binding, 'serialized backup account must be a string');
    assertSafeAccount(parsed.account, binding);
    stored.account = parsed.account;
  }
  if (parsed.persist !== undefined) {
    if (typeof parsed.persist !== 'string') throw malformedBackup(binding, 'serialized backup persist must be a string');
    assertSafePersist(parsed.persist, binding);
    stored.persist = parsed.persist;
  }
  return stored;
}

function storedFromReadResult(
  binding: WindowsCredentialBinding,
  result: WindowsCredentialBridgeReadPresent
): WindowsCredentialStoredV1 {
  assertSecretSize(result.secret, binding);
  const stored: WindowsCredentialStoredV1 = {
    schemaVersion: 1,
    targetName: binding.targetName,
    credentialType: 'generic',
    secret: result.secret,
    persist: result.persist ?? binding.persist ?? 'session'
  };
  if (result.account !== undefined) {
    assertSafeAccount(result.account, binding);
    stored.account = result.account;
  } else if (binding.account !== undefined) {
    stored.account = binding.account;
  }
  return stored;
}

function writeRequestFromStored(
  binding: WindowsCredentialBinding,
  stored: WindowsCredentialStoredV1,
  metadataPreference: 'binding-first' | 'stored-first' = 'binding-first'
): WindowsCredentialBridgeWriteRequest {
  const account = metadataPreference === 'stored-first'
    ? stored.account ?? binding.account ?? DEFAULT_ACCOUNT
    : binding.account ?? stored.account ?? DEFAULT_ACCOUNT;
  assertSafeAccount(account, binding);
  const persist = metadataPreference === 'stored-first'
    ? stored.persist ?? binding.persist ?? 'session'
    : binding.persist ?? stored.persist ?? 'session';
  assertSafePersist(persist, binding);
  assertSecretSize(stored.secret, binding);
  return {
    targetName: binding.targetName,
    credentialType: 'generic',
    account,
    persist,
    secret: stored.secret
  };
}

async function readViaBridge(bridge: WindowsCredentialBridge, binding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeReadResult> {
  try {
    return await bridge.read(binding);
  } catch (err) {
    const converted = toWindowsCredentialError(err, 'bridge-failed', binding, 'read');
    if (converted.code === 'missing') return { status: 'missing' };
    throw converted;
  }
}

async function inspectViaBridge(bridge: WindowsCredentialBridge, binding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeInspectResult> {
  try {
    return await bridge.inspect(binding);
  } catch (err) {
    const converted = toWindowsCredentialError(err, 'bridge-failed', binding, 'inspect');
    if (converted.code === 'missing') return { status: 'missing' };
    throw converted;
  }
}

export function assertWindowsCredentialAccountMetadataMatches(
  binding: WindowsCredentialBinding,
  metadata: { account?: string },
  phase = 'inspect'
): void {
  const safeBinding = validateWindowsCredentialBinding(binding);
  assertAccountMetadataMatches(safeBinding, metadata, phase);
}

function assertAccountMetadataMatches(
  binding: WindowsCredentialBinding,
  metadata: { account?: string },
  phase: string
): void {
  if (metadata.account !== undefined) assertSafeAccount(metadata.account, binding);
  if (binding.account === undefined) return;
  if (metadata.account === binding.account) return;
  throw new WindowsCredentialError(
    'account-mismatch',
    'windows credential account metadata does not match binding',
    safeDetails(binding, phase)
  );
}

async function writeViaBridge(bridge: WindowsCredentialBridge, request: WindowsCredentialBridgeWriteRequest): Promise<void> {
  await bridge.write(request);
}

function malformedBackup(binding: WindowsCredentialBinding, reason: string): WindowsCredentialError {
  return new WindowsCredentialError('malformed-backup', reason, safeDetails(binding, 'parse-backup'));
}

function toWindowsCredentialError(
  err: unknown,
  fallbackCode: WindowsCredentialErrorCode,
  binding: WindowsCredentialBinding,
  phase: string
): WindowsCredentialError {
  if (err instanceof WindowsCredentialError) return err;
  return new WindowsCredentialError(fallbackCode, `windows credential ${phase} failed`, safeDetails(binding, phase));
}

function safeDetails(binding: Partial<WindowsCredentialBinding>, phase: string): WindowsCredentialErrorDetails {
  return {
    phase,
    targetHash: typeof binding.targetName === 'string' ? maskIdentifier(binding.targetName) : undefined,
    accountHash: typeof binding.account === 'string' ? maskIdentifier(binding.account) : undefined,
    credentialType: binding.credentialType === 'generic' ? 'generic' : undefined
  };
}

function assertSafeTargetName(targetName: unknown): asserts targetName is string {
  if (typeof targetName !== 'string' || targetName.length === 0) {
    throw new WindowsCredentialError('invalid-input', 'windows credential targetName must be a non-empty string');
  }
  if (targetName.length > CRED_MAX_GENERIC_TARGET_NAME_LENGTH) {
    throw new WindowsCredentialError('invalid-input', 'windows credential targetName is too long');
  }
  if (hasUnsafeDisplayChar(targetName) || targetName.includes('\x00')) {
    throw new WindowsCredentialError('invalid-input', 'windows credential targetName contains unsafe characters');
  }
}

function assertSafeAccount(account: unknown, binding: Partial<WindowsCredentialBinding>): asserts account is string {
  if (typeof account !== 'string' || account.length === 0) {
    throw new WindowsCredentialError('invalid-input', 'windows credential account must be a non-empty string', safeDetails(binding, 'validate'));
  }
  if (account.length > CRED_MAX_USERNAME_LENGTH) {
    throw new WindowsCredentialError('invalid-input', 'windows credential account is too long', safeDetails(binding, 'validate'));
  }
  if (hasUnsafeDisplayChar(account) || account.includes('\x00')) {
    throw new WindowsCredentialError('invalid-input', 'windows credential account contains unsafe characters', safeDetails(binding, 'validate'));
  }
}

function assertSafePersist(persist: unknown, binding: Partial<WindowsCredentialBinding>): asserts persist is WindowsCredentialPersist {
  if (persist !== 'session' && persist !== 'local-machine' && persist !== 'enterprise') {
    throw new WindowsCredentialError('invalid-input', 'windows credential persist value is unsupported', safeDetails(binding, 'validate'));
  }
}

function assertSecretSize(secret: string, binding: Partial<WindowsCredentialBinding>): void {
  const byteLength = Buffer.byteLength(secret, 'utf16le');
  if (byteLength > CRED_MAX_CREDENTIAL_BLOB_SIZE) {
    throw new WindowsCredentialError('malformed-backup', 'windows credential secret is too large', safeDetails(binding, 'validate-secret'));
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface BridgeOutputOkMissing {
  ok: true;
  status: 'missing';
}

interface BridgeOutputOkPresent {
  ok: true;
  status: 'present';
  secret?: string;
  account?: string;
  persist?: number;
}

interface BridgeOutputOkWritten {
  ok: true;
  status: 'written' | 'deleted';
}

interface BridgeOutputError {
  ok: false;
  kind?: WindowsCredentialErrorCode;
  phase?: string;
  api?: string;
  win32Code?: number;
  win32Name?: string;
}

type BridgeOutput = BridgeOutputOkMissing | BridgeOutputOkPresent | BridgeOutputOkWritten | BridgeOutputError;

class PowerShellPInvokeWindowsCredentialBridge implements WindowsCredentialBridge {
  async inspect(binding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeInspectResult> {
    const out = await invokePowerShellBridge({ operation: 'inspect', binding });
    if (!out.ok) throw bridgeOutputError(out, binding, 'inspect');
    if (out.status === 'missing') return { status: 'missing' };
    if (out.status !== 'present') {
      throw new WindowsCredentialError('bridge-failed', 'windows credential bridge returned invalid inspect status', safeDetails(binding, 'inspect'));
    }
    const persist = bridgePersist(out, binding, 'inspect');
    return {
      status: 'present',
      ...(typeof out.account === 'string' && out.account.length > 0 ? { account: out.account } : {}),
      ...(persist !== undefined ? { persist } : {})
    };
  }

  async read(binding: WindowsCredentialBinding): Promise<WindowsCredentialBridgeReadResult> {
    const out = await invokePowerShellBridge({ operation: 'read', binding });
    if (!out.ok) throw bridgeOutputError(out, binding, 'read');
    if (out.status === 'missing') return { status: 'missing' };
    if (out.status !== 'present' || typeof out.secret !== 'string') {
      throw new WindowsCredentialError('bridge-failed', 'windows credential bridge returned invalid read status', safeDetails(binding, 'read'));
    }
    const persist = bridgePersist(out, binding, 'read');
    return {
      status: 'present',
      secret: out.secret,
      ...(typeof out.account === 'string' && out.account.length > 0 ? { account: out.account } : {}),
      ...(persist !== undefined ? { persist } : {})
    };
  }

  async write(request: WindowsCredentialBridgeWriteRequest): Promise<void> {
    const out = await invokePowerShellBridge({ operation: 'write', binding: request, secret: request.secret });
    if (!out.ok) throw bridgeOutputError(out, request, 'write');
    if (out.status !== 'written') {
      throw new WindowsCredentialError('bridge-failed', 'windows credential bridge returned invalid write status', safeDetails(request, 'write'));
    }
  }

  async delete(binding: WindowsCredentialBinding): Promise<'deleted' | 'missing'> {
    const out = await invokePowerShellBridge({ operation: 'delete', binding });
    if (!out.ok) throw bridgeOutputError(out, binding, 'delete');
    if (out.status === 'missing' || out.status === 'deleted') return out.status;
    throw new WindowsCredentialError('bridge-failed', 'windows credential bridge returned invalid delete status', safeDetails(binding, 'delete'));
  }
}

const defaultWindowsCredentialBridge = new PowerShellPInvokeWindowsCredentialBridge();

async function invokePowerShellBridge(request: {
  operation: 'inspect' | 'read' | 'write' | 'delete';
  binding: WindowsCredentialBinding;
  secret?: string;
}): Promise<BridgeOutput> {
  if (process.platform !== 'win32') {
    throw new WindowsCredentialError('unsupported-platform', 'windows credential bridge requires win32', safeDetails(request.binding, request.operation));
  }
  const payload = JSON.stringify({
    operation: request.operation,
    targetName: request.binding.targetName,
    credentialType: request.binding.credentialType,
    account: request.operation === 'write' ? (request.binding.account ?? DEFAULT_ACCOUNT) : request.binding.account,
    persist: PERSIST_TO_WIN32[request.binding.persist ?? 'session'],
    ...(request.secret !== undefined ? { secret: request.secret } : {})
  });
  const encoded = Buffer.from(WINDOWS_CREDENTIAL_POWERSHELL_BRIDGE, 'utf16le').toString('base64');
  const result = await runCommand(POWERSHELL_EXE, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-EncodedCommand',
    encoded
  ], payload);
  if (result.code !== 0) {
    throw new WindowsCredentialError('bridge-failed', 'windows credential bridge process failed', safeDetails(request.binding, request.operation));
  }
  try {
    return JSON.parse(result.stdout.trim()) as BridgeOutput;
  } catch {
    throw new WindowsCredentialError('bridge-failed', 'windows credential bridge returned invalid JSON', safeDetails(request.binding, request.operation));
  }
}

function bridgePersist(out: BridgeOutputOkPresent, binding: WindowsCredentialBinding, phase: string): WindowsCredentialPersist | undefined {
  const persist = out.persist === undefined ? undefined : WIN32_TO_PERSIST.get(out.persist);
  if (out.persist !== undefined && persist === undefined) {
    throw new WindowsCredentialError('bridge-failed', 'windows credential bridge returned unsupported persist value', safeDetails(binding, phase));
  }
  return persist;
}

function safeWin32Name(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Z0-9_]+$/.test(value) ? value.slice(0, 80) : undefined;
}

function bridgeOutputError(out: BridgeOutputError, binding: WindowsCredentialBinding, fallbackPhase: string): WindowsCredentialError {
  const phase = out.phase ?? fallbackPhase;
  const code = out.kind ?? 'bridge-failed';
  return new WindowsCredentialError(code, `windows credential bridge ${phase} failed`, {
    ...safeDetails(binding, phase),
    win32Code: typeof out.win32Code === 'number' ? out.win32Code : undefined,
    win32Name: safeWin32Name(out.win32Name)
  });
}

const WINDOWS_CREDENTIAL_POWERSHELL_BRIDGE = String.raw`
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Write-BridgeJson {
  param([Parameter(Mandatory = $true)]$Value)
  $Value | ConvertTo-Json -Compress -Depth 8 | Write-Output
}

function Get-Win32ErrorName {
  param([Parameter(Mandatory = $true)][int]$Code)
  switch ($Code) {
    0 { 'ERROR_SUCCESS'; break }
    5 { 'ERROR_ACCESS_DENIED'; break }
    87 { 'ERROR_INVALID_PARAMETER'; break }
    1168 { 'ERROR_NOT_FOUND'; break }
    1312 { 'ERROR_NO_SUCH_LOGON_SESSION'; break }
    2202 { 'ERROR_BAD_USERNAME'; break }
    default { 'WIN32_ERROR_{0}' -f $Code; break }
  }
}

function Get-BridgeKind {
  param([Parameter(Mandatory = $true)][int]$Code, [Parameter(Mandatory = $true)][string]$Phase)
  switch ($Code) {
    5 { 'access-denied'; break }
    87 { 'invalid-input'; break }
    1168 { 'missing'; break }
    1312 { 'api-unavailable'; break }
    2202 { 'invalid-input'; break }
    default {
      if ($Phase -eq 'delete') { 'delete-failed' }
      elseif ($Phase -eq 'write') { 'write-failed' }
      else { 'bridge-failed' }
      break
    }
  }
}

function New-BridgeFailure {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][string]$Api,
    [Parameter(Mandatory = $true)][int]$Code
  )
  return @{
    ok = $false
    kind = (Get-BridgeKind -Code $Code -Phase $Phase)
    phase = $Phase
    api = $Api
    win32Code = $Code
    win32Name = (Get-Win32ErrorName -Code $Code)
  }
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MatWinCredBridge
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct Credential
    {
        public UInt32 Flags;
        public UInt32 Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public UInt32 CredentialBlobSize;
        public IntPtr CredentialBlob;
        public UInt32 Persist;
        public UInt32 AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    public static class NativeMethods
    {
        [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CredWrite(ref Credential credential, UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CredRead(
            [MarshalAs(UnmanagedType.LPWStr)] string targetName,
            UInt32 type,
            UInt32 reservedFlag,
            out IntPtr credentialPtr);

        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool CredDelete(
            [MarshalAs(UnmanagedType.LPWStr)] string targetName,
            UInt32 type,
            UInt32 flags);

        [DllImport("advapi32.dll", EntryPoint = "CredFree", SetLastError = false)]
        public static extern void CredFree(IntPtr buffer);
    }
}
"@

function Invoke-BridgeRead {
  param([Parameter(Mandatory = $true)]$Request)
  $credentialPtr = [IntPtr]::Zero
  $ok = [MatWinCredBridge.NativeMethods]::CredRead($Request.targetName, [UInt32]1, [UInt32]0, [ref]$credentialPtr)
  if (-not $ok) {
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 1168) { return @{ ok = $true; status = 'missing' } }
    return New-BridgeFailure -Phase 'read' -Api 'CredReadW' -Code $errorCode
  }

  $bytes = $null
  try {
    if ($credentialPtr -eq [IntPtr]::Zero) { return @{ ok = $false; kind = 'bridge-failed'; phase = 'read' } }
    $credential = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
      $credentialPtr,
      [type][MatWinCredBridge.Credential]
    )
    $blobSize = [int]$credential.CredentialBlobSize
    if ($blobSize -lt 0 -or ($blobSize % 2) -ne 0) { return @{ ok = $false; kind = 'bridge-failed'; phase = 'read' } }
    if ($blobSize -gt 0 -and $credential.CredentialBlob -eq [IntPtr]::Zero) { return @{ ok = $false; kind = 'bridge-failed'; phase = 'read' } }
    $bytes = New-Object byte[] $blobSize
    if ($blobSize -gt 0) {
      [System.Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $blobSize)
    }
    $secret = [System.Text.Encoding]::Unicode.GetString($bytes)
    return @{
      ok = $true
      status = 'present'
      secret = $secret
      account = $credential.UserName
      persist = [int]$credential.Persist
    }
  } finally {
    if ($bytes -ne $null) { [Array]::Clear($bytes, 0, $bytes.Length) }
    if ($credentialPtr -ne [IntPtr]::Zero) { [MatWinCredBridge.NativeMethods]::CredFree($credentialPtr) }
  }
}

function Invoke-BridgeInspect {
  param([Parameter(Mandatory = $true)]$Request)
  $credentialPtr = [IntPtr]::Zero
  $ok = [MatWinCredBridge.NativeMethods]::CredRead($Request.targetName, [UInt32]1, [UInt32]0, [ref]$credentialPtr)
  if (-not $ok) {
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq 1168) { return @{ ok = $true; status = 'missing' } }
    return New-BridgeFailure -Phase 'inspect' -Api 'CredReadW' -Code $errorCode
  }

  try {
    if ($credentialPtr -eq [IntPtr]::Zero) { return @{ ok = $false; kind = 'bridge-failed'; phase = 'inspect' } }
    $credential = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
      $credentialPtr,
      [type][MatWinCredBridge.Credential]
    )
    return @{
      ok = $true
      status = 'present'
      account = $credential.UserName
      persist = [int]$credential.Persist
    }
  } finally {
    if ($credentialPtr -ne [IntPtr]::Zero) { [MatWinCredBridge.NativeMethods]::CredFree($credentialPtr) }
  }
}

function Clear-UnmanagedBuffer {
  param([Parameter(Mandatory = $true)][IntPtr]$Pointer, [Parameter(Mandatory = $true)][int]$Size)
  if ($Pointer -eq [IntPtr]::Zero) { return }
  if ($Size -gt 0) {
    $zeros = New-Object byte[] $Size
    [System.Runtime.InteropServices.Marshal]::Copy($zeros, 0, $Pointer, $Size)
  }
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($Pointer)
}

function Invoke-BridgeWrite {
  param([Parameter(Mandatory = $true)]$Request)
  if ($null -eq $Request.secret -or -not ($Request.secret -is [string])) {
    return @{ ok = $false; kind = 'invalid-input'; phase = 'write' }
  }
  $secretBytes = [System.Text.Encoding]::Unicode.GetBytes($Request.secret)
  $secretByteLength = $secretBytes.Length
  $blobPtr = [IntPtr]::Zero
  try {
    $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($secretByteLength)
    if ($secretByteLength -gt 0) {
      [System.Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blobPtr, $secretByteLength)
    }
    $credential = [MatWinCredBridge.Credential]::new()
    $credential.Flags = [UInt32]0
    $credential.Type = [UInt32]1
    $credential.TargetName = $Request.targetName
    $credential.Comment = $null
    $credential.CredentialBlobSize = [UInt32]$secretByteLength
    $credential.CredentialBlob = $blobPtr
    $credential.Persist = [UInt32]$Request.persist
    $credential.AttributeCount = [UInt32]0
    $credential.Attributes = [IntPtr]::Zero
    $credential.TargetAlias = $null
    $credential.UserName = $Request.account

    $ok = [MatWinCredBridge.NativeMethods]::CredWrite([ref]$credential, [UInt32]0)
    if (-not $ok) {
      $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      return New-BridgeFailure -Phase 'write' -Api 'CredWriteW' -Code $errorCode
    }
    return @{ ok = $true; status = 'written' }
  } finally {
    [Array]::Clear($secretBytes, 0, $secretByteLength)
    Clear-UnmanagedBuffer -Pointer $blobPtr -Size $secretByteLength
  }
}

function Invoke-BridgeDelete {
  param([Parameter(Mandatory = $true)]$Request)
  $ok = [MatWinCredBridge.NativeMethods]::CredDelete($Request.targetName, [UInt32]1, [UInt32]0)
  if ($ok) { return @{ ok = $true; status = 'deleted' } }
  $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($errorCode -eq 1168) { return @{ ok = $true; status = 'missing' } }
  return New-BridgeFailure -Phase 'delete' -Api 'CredDeleteW' -Code $errorCode
}

try {
  $inputJson = [Console]::In.ReadToEnd()
  $request = $inputJson | ConvertFrom-Json
  if ($request.credentialType -ne 'generic') { Write-BridgeJson @{ ok = $false; kind = 'invalid-input'; phase = 'validate' }; exit 0 }
  switch ($request.operation) {
    'inspect' { Write-BridgeJson (Invoke-BridgeInspect -Request $request); exit 0 }
    'read' { Write-BridgeJson (Invoke-BridgeRead -Request $request); exit 0 }
    'write' { Write-BridgeJson (Invoke-BridgeWrite -Request $request); exit 0 }
    'delete' { Write-BridgeJson (Invoke-BridgeDelete -Request $request); exit 0 }
    default { Write-BridgeJson @{ ok = $false; kind = 'invalid-input'; phase = 'validate' }; exit 0 }
  }
} catch {
  Write-BridgeJson @{ ok = $false; kind = 'bridge-failed'; phase = 'bridge' }
  exit 0
}
`;
