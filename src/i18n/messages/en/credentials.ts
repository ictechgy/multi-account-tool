/**
 * 영어 메시지 — `credentials` 영역 (keychain / os-keyring source, 프로필 전환 에러).
 * 키 구조가 기준 스키마이며 ko/credentials.ts 가 같은 키를 가져야 한다.
 *
 * 주의: os-keyring 의 **plain Error** 문구(osKeyringInvalidAccount / osKeyringParseFailed /
 * osKeyringBackupCorrupted)에는 ENOENT·daemon·denied·locked·EACCES·cleanup·delete 를 넣지 않는다 —
 * `classifyLssError` 가 typed 가 아닌 에러는 이 영문 토큰으로 분류한다.
 */
export const credentials = {
  // errors.ts
  unknownCli: (cliId: string) => `Unknown CLI: ${cliId}`,
  keychainAccountMissing: (displayService: string) =>
    `Cannot determine the account of the existing entry for keychain service '${displayService}', so mat refuses the safe swap. ` +
    `A service-only delete can affect other entries of the same service and risks data loss. ` +
    `Clean up the entries for this service manually in Keychain Access.app, then try again.`,
  /** `stage` 는 keychainStages 의 라벨. `detail` 은 이미 redact 된 값, `suffix` 는 롤백 note. */
  keychainCommandFailed: (stage: string, exitCode: number, detail: string, suffix: string) =>
    `keychain ${stage} failed (code=${exitCode}): ${detail}${suffix}`,
  osKeyringAccountMissing: (displayService: string, matchCount: number) =>
    `os-keyring service '${displayService}': ` +
    (matchCount > 1
      ? `${matchCount} entries matched (collision), so mat refuses the safe swap. `
      : `cannot identify the account of the existing entry, so mat refuses the safe swap. `) +
    `secret-tool clear deletes every matching entry, so proceeding without a confirmed account ` +
    `could lose unrelated credentials. ` +
    `Clean up the entries for this service with secret-tool or a keyring manager, then try again.`,

  // sources.ts (macOS Keychain)
  keychainStages: {
    read: 'read',
    deleteBackupEntry: 'delete backup entry',
    write: 'write'
  },
  unhandledSourceType: (type: string) => `Unhandled source type: ${type}`,
  keychainInvalidAccount: (displayService: string) =>
    `KeychainSource.account is invalid (empty string, contains NUL, etc.): service=${displayService}`,
  /** `stderr` 는 이미 redact 된 값. */
  keychainRollbackFailed: (code: number, stderr: string) => ` / backup restore also failed (code=${code}): ${stderr}`,
  keychainMacOnly: 'keychain source is supported only on macOS.',
  keychainBackupCorrupted: 'keychain backup is corrupted: the value field is not a string.',

  // os-keyring.ts (Linux Secret Service)
  osKeyringStages: {
    lookup: 'lookup',
    deleteEntry: 'delete entry'
  },
  osKeyringInvalidAccount: (displayService: string) =>
    `OsKeyringSource.account is invalid (empty string, contains NUL, etc.): service=${displayService}`,
  osKeyringDaemonUnavailable: (stage: string, code: number) =>
    `os-keyring ${stage} failed (code=${code}): Secret Service keyring daemon not responding or access denied. ` +
    `Make sure a keyring daemon such as gnome-keyring is running.`,
  osKeyringNotInstalled: (stage: string, bin: string) =>
    `os-keyring ${stage} failed: secret-tool is not installed ` +
    `(${bin} missing, ENOENT). Install the libsecret-tools package, or, ` +
    `if the CLI supports a file backend (plain-text file) mode, switch to it (see README).`,
  osKeyringSpawnFailed: (stage: string, bin: string, errno: string | undefined) =>
    `os-keyring ${stage} failed: cannot run secret-tool ` +
    `(${bin}, errno=${errno ?? 'unknown'}). Check execute permission and the binary.`,
  osKeyringParseFailed: 'os-keyring search result parse failed: found 1 block but could not extract the secret.',
  osKeyringRollbackFailed: (code: number) => ` / backup restore also failed (code=${code})`,
  osKeyringWriteFailed: (code: number, rollbackNote: string) => `os-keyring write failed (code=${code})${rollbackNote}`,
  osKeyringBackupCorrupted: 'os-keyring backup is corrupted: the value field is not a string.',

  // switcher.ts
  doctorHint: (saveAs: string) => ` (${saveAs}; check with 'mat doctor')`,
  profileNotFound: (cliId: string, profileName: string) => `Profile not found: ${cliId}/${profileName}`,
  unsavedLiveCredentials: (cliId: string, liveSources: string) =>
    `The current ${cliId} login is not saved in any profile, so mat cannot switch to a logged-out state ` +
    `(live: ${liveSources}). First use 'Copy current login' to save it to a profile.`,
  freshnessCheckFailed: (cliId: string, profileName: string, message: string) =>
    `[mat] freshness check failed (swap continued): cli=${cliId} profile=${profileName}: ${message}`
};
