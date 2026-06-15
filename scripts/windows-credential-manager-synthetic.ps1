# Non-product Windows Credential Manager synthetic API proof.
# This script is intentionally standalone and is not imported by product runtime.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$isWindowsRuntime = [System.Runtime.InteropServices.RuntimeInformation]::IsOSPlatform(
  [System.Runtime.InteropServices.OSPlatform]::Windows
)
if (-not $isWindowsRuntime) {
  throw 'Windows Credential Manager synthetic proof must run on Windows.'
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

namespace MatWinCredSynthetic
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

$script:CredTypeGeneric = [UInt32]1
$script:CredPersistSession = [UInt32]1
$script:ErrorNotFound = 1168
$script:RunId = if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID)) { 'local' } else { $env:GITHUB_RUN_ID }
$script:TargetPrefix = 'mat-ci'
$targetName = '{0}/{1}/{2}' -f $script:TargetPrefix, $script:RunId, ([Guid]::NewGuid().ToString('N'))

function Get-Win32ErrorName {
  param([Parameter(Mandatory = $true)][int]$Code)

  switch ($Code) {
    0 { 'ERROR_SUCCESS'; break }
    5 { 'ERROR_ACCESS_DENIED'; break }
    1168 { 'ERROR_NOT_FOUND'; break }
    default { 'WIN32_ERROR_{0}' -f $Code; break }
  }
}

function New-Win32FailureMessage {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [Parameter(Mandatory = $true)][string]$Api,
    [Parameter(Mandatory = $true)][int]$Code
  )

  return ('phase={0} api={1} targetPrefix={2} runId={3} win32={4} code={5}' -f $Phase, $Api, $script:TargetPrefix, $script:RunId, (Get-Win32ErrorName -Code $Code), $Code)
}

function Write-ProofPhase {
  param(
    [Parameter(Mandatory = $true)][string]$Phase,
    [string]$Status = 'ok'
  )

  Write-Host ('phase={0} status={1} targetPrefix={2} runId={3}' -f $Phase, $Status, $script:TargetPrefix, $script:RunId)
}

function Invoke-CredDeleteSynthetic {
  param(
    [Parameter(Mandatory = $true)][string]$TargetName,
    [Parameter(Mandatory = $true)][string]$Phase,
    [switch]$TolerateMissing
  )

  $ok = [MatWinCredSynthetic.NativeMethods]::CredDelete($TargetName, $script:CredTypeGeneric, [UInt32]0)
  if ($ok) {
    Write-ProofPhase -Phase $Phase -Status 'deleted'
    return
  }

  # Capture last-error immediately after the failed Win32 call.
  $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($TolerateMissing -and $errorCode -eq $script:ErrorNotFound) {
    Write-ProofPhase -Phase $Phase -Status 'missing'
    return
  }

  throw (New-Win32FailureMessage -Phase $Phase -Api 'CredDeleteW' -Code $errorCode)
}

function Assert-CredMissingSynthetic {
  param(
    [Parameter(Mandatory = $true)][string]$TargetName,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $credentialPtr = [IntPtr]::Zero
  $ok = [MatWinCredSynthetic.NativeMethods]::CredRead($TargetName, $script:CredTypeGeneric, [UInt32]0, [ref]$credentialPtr)
  if (-not $ok) {
    # Capture last-error immediately after the failed Win32 call.
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    if ($errorCode -eq $script:ErrorNotFound) {
      Write-ProofPhase -Phase $Phase -Status 'missing'
      return
    }
    throw (New-Win32FailureMessage -Phase $Phase -Api 'CredReadW' -Code $errorCode)
  }

  if ($credentialPtr -ne [IntPtr]::Zero) {
    [MatWinCredSynthetic.NativeMethods]::CredFree($credentialPtr)
  }
  throw ('phase={0} status=unexpected-present targetPrefix={1} runId={2}' -f $Phase, $script:TargetPrefix, $script:RunId)
}

function New-SyntheticSecret {
  param([Parameter(Mandatory = $true)][string]$Label)

  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try {
    $rng.GetBytes($bytes)
    return ('{0}-{1}' -f $Label, [Convert]::ToBase64String($bytes))
  } finally {
    [Array]::Clear($bytes, 0, $bytes.Length)
    $rng.Dispose()
  }
}

function Clear-UnmanagedBuffer {
  param(
    [Parameter(Mandatory = $true)][IntPtr]$Pointer,
    [Parameter(Mandatory = $true)][int]$Size
  )

  if ($Pointer -eq [IntPtr]::Zero) { return }
  if ($Size -gt 0) {
    $zeros = New-Object byte[] $Size
    [System.Runtime.InteropServices.Marshal]::Copy($zeros, 0, $Pointer, $Size)
  }
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($Pointer)
}

function Write-CredSynthetic {
  param(
    [Parameter(Mandatory = $true)][string]$TargetName,
    [Parameter(Mandatory = $true)][string]$Secret,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $secretBytes = [System.Text.Encoding]::Unicode.GetBytes($Secret)
  $secretByteLength = $secretBytes.Length
  $blobPtr = [IntPtr]::Zero
  try {
    $blobPtr = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($secretByteLength)
    [System.Runtime.InteropServices.Marshal]::Copy($secretBytes, 0, $blobPtr, $secretByteLength)

    $credential = [MatWinCredSynthetic.Credential]::new()
    $credential.Flags = [UInt32]0
    $credential.Type = $script:CredTypeGeneric
    $credential.TargetName = $TargetName
    $credential.Comment = $null
    $credential.CredentialBlobSize = [UInt32]$secretByteLength
    $credential.CredentialBlob = $blobPtr
    $credential.Persist = $script:CredPersistSession
    $credential.AttributeCount = [UInt32]0
    $credential.Attributes = [IntPtr]::Zero
    $credential.TargetAlias = $null
    $credential.UserName = 'mat-ci-synthetic'

    $ok = [MatWinCredSynthetic.NativeMethods]::CredWrite([ref]$credential, [UInt32]0)
    if (-not $ok) {
      # Capture last-error immediately after the failed Win32 call.
      $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw (New-Win32FailureMessage -Phase $Phase -Api 'CredWriteW' -Code $errorCode)
    }

    Write-ProofPhase -Phase $Phase -Status 'written'
  } finally {
    [Array]::Clear($secretBytes, 0, $secretByteLength)
    Clear-UnmanagedBuffer -Pointer $blobPtr -Size $secretByteLength
  }
}

function Assert-CredEqualsSynthetic {
  param(
    [Parameter(Mandatory = $true)][string]$TargetName,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Phase
  )

  $credentialPtr = [IntPtr]::Zero
  $bytes = $null
  $actual = $null
  $expectedByteCount = [System.Text.Encoding]::Unicode.GetByteCount($Expected)

  $ok = [MatWinCredSynthetic.NativeMethods]::CredRead($TargetName, $script:CredTypeGeneric, [UInt32]0, [ref]$credentialPtr)
  if (-not $ok) {
    # Capture last-error immediately after the failed Win32 call.
    $errorCode = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw (New-Win32FailureMessage -Phase $Phase -Api 'CredReadW' -Code $errorCode)
  }

  try {
    if ($credentialPtr -eq [IntPtr]::Zero) {
      throw ('phase={0} status=null-credential targetPrefix={1} runId={2}' -f $Phase, $script:TargetPrefix, $script:RunId)
    }

    $credential = [System.Runtime.InteropServices.Marshal]::PtrToStructure(
      $credentialPtr,
      [type][MatWinCredSynthetic.Credential]
    )
    $blobSize = [int]$credential.CredentialBlobSize
    if ($blobSize -lt 0 -or ($blobSize % 2) -ne 0) {
      throw ('phase={0} status=invalid-blob-size targetPrefix={1} runId={2}' -f $Phase, $script:TargetPrefix, $script:RunId)
    }
    if ($blobSize -ne $expectedByteCount) {
      throw ('phase={0} status=unexpected-blob-size targetPrefix={1} runId={2}' -f $Phase, $script:TargetPrefix, $script:RunId)
    }
    if ($blobSize -gt 0 -and $credential.CredentialBlob -eq [IntPtr]::Zero) {
      throw ('phase={0} status=null-blob targetPrefix={1} runId={2}' -f $Phase, $script:TargetPrefix, $script:RunId)
    }

    $bytes = New-Object byte[] $blobSize
    if ($blobSize -gt 0) {
      [System.Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $blobSize)
    }
    $actual = [System.Text.Encoding]::Unicode.GetString($bytes)
    if ($actual -ne $Expected) {
      throw ('phase={0} status=value-mismatch targetPrefix={1} runId={2}' -f $Phase, $script:TargetPrefix, $script:RunId)
    }

    Write-ProofPhase -Phase $Phase -Status 'matched'
  } finally {
    if ($null -ne $bytes) {
      [Array]::Clear($bytes, 0, $bytes.Length)
    }
    $actual = $null
    if ($credentialPtr -ne [IntPtr]::Zero) {
      [MatWinCredSynthetic.NativeMethods]::CredFree($credentialPtr)
    }
  }
}

$secretA = $null
$secretB = $null
try {
  Write-ProofPhase -Phase 'start'
  Invoke-CredDeleteSynthetic -TargetName $targetName -Phase 'pre-cleanup' -TolerateMissing
  Assert-CredMissingSynthetic -TargetName $targetName -Phase 'initial-missing'

  $secretA = New-SyntheticSecret -Label 'a'
  Write-CredSynthetic -TargetName $targetName -Secret $secretA -Phase 'write-a'
  Assert-CredEqualsSynthetic -TargetName $targetName -Expected $secretA -Phase 'read-a'

  $secretB = New-SyntheticSecret -Label 'b'
  Write-CredSynthetic -TargetName $targetName -Secret $secretB -Phase 'overwrite-b'
  Assert-CredEqualsSynthetic -TargetName $targetName -Expected $secretB -Phase 'read-b'

  Invoke-CredDeleteSynthetic -TargetName $targetName -Phase 'delete'
  Assert-CredMissingSynthetic -TargetName $targetName -Phase 'final-missing'
  Write-ProofPhase -Phase 'complete'
} finally {
  $secretA = $null
  $secretB = $null
  Invoke-CredDeleteSynthetic -TargetName $targetName -Phase 'final-cleanup' -TolerateMissing
}
