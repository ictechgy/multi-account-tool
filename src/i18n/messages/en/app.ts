/** 영어 메시지 — `app` 영역. 키 구조가 기준 스키마이며 ko/app.ts 가 같은 키를 가져야 한다. */
export const app = {
  header: {
    subtitle: 'Switch between AI CLI accounts from one TUI'
  },
  /** 값이 없을 때 표시하는 자리표시자 (활성 프로필 / 프로필 목록). */
  none: '(none)',
  unknownCli: 'Unknown CLI...',
  prompts: {
    newProfileName: (cliName: string) => `${cliName} — new profile name`,
    renameTo: (cliName: string, oldName: string) => `${cliName} / ${oldName} → new name`
  },
  firstImport: {
    title: 'Import existing credentials',
    importAll: 'Import all',
    skip: 'Skip'
  },
  busy: {
    checkingCredentials: 'Checking credentials...',
    importingCredentials: 'Importing credentials...',
    switching: 'Switching...',
    recaptureAndSwitch: 'Recapturing live credentials, then switching...',
    discardAndSwitch: 'Discarding live credentials, then switching...',
    switchingToNewAccount: 'Switching to new-account profile...',
    creatingProfile: 'Creating profile...',
    recaptureAndCreate: 'Recapturing live credentials, then creating profile...',
    renaming: 'Renaming...',
    deleting: 'Deleting...',
    capturing: 'Capturing...'
  },
  switchConfirmTitle: (cliName: string) => `Switch ${cliName} profile`,
  freshness: {
    checkFailedTitle: 'Credential check failed',
    inflightTitle: 'Credentials refreshing (retry recommended)',
    inflightBody:
      'Live credentials appear to be mid-refresh (multi-source partial update).\n' +
      'Try again in a moment.'
  },
  activeChanged: {
    title: 'Active profile changed — operation cancelled',
    body: (expected: string, current: string) =>
      `Another tool changed the active profile while the dialog was open.\n` +
      `Expected: '${expected}' / Current: '${current}'\n\n` +
      `Cancelled because live credentials could be written to an unintended profile.\n` +
      `Check the profile list and try again.`
  },
  firstImportChanged: (cliId: string, expected: string, current: string) =>
    `The ${cliId} profile list changed while the import dialog was open.\n` +
    `Expected: ${expected} / Current: ${current}\n\n` +
    `Another operation changed the profiles first, so the stale import was cancelled.\n` +
    `Check the profile list and try again.`,
  switchDone: {
    title: 'Switch complete',
    errorTitle: 'Switch failed'
  },
  recaptureSwitch: {
    title: 'Recapture + switch complete',
    body: (currentActive: string, to: string) =>
      `Saved live credentials to '${currentActive}', then switched to '${to}'.`,
    errorTitle: 'Recapture/switch failed'
  },
  discardSwitch: {
    title: 'Discard + switch complete',
    body: (to: string) => `Discarded live credentials without a backup and switched to '${to}'.`,
    errorTitle: 'Discard/switch failed'
  },
  freshSwitch: {
    title: 'Switched to new-account profile',
    discarded: 'Discarded live credentials without a backup.',
    errorTitle: 'Failed to switch to new-account profile'
  },
  create: {
    title: 'Profile created',
    body: (name: string) => `Profile '${name}' created. (The active profile was not changed.)`,
    captured: (files: string) => `Captured live credentials: ${files}`,
    empty: 'No live credentials found, so the profile was created empty.',
    errorTitle: 'Failed to create profile'
  },
  recaptureCreate: {
    title: 'Recapture + profile creation complete',
    body: (currentActive: string, newName: string) =>
      `Saved live credentials to '${currentActive}', then created profile '${newName}'.`,
    keptActive: (currentActive: string) => `(Active profile stays '${currentActive}')`,
    capturedFiles: (files: string) => `Captured files: ${files}`,
    errorTitle: 'Recapture/create failed'
  },
  rename: {
    title: 'Rename complete',
    errorTitle: 'Rename failed'
  },
  delete: {
    activeTitle: 'Cannot delete the active profile',
    activeBody: (name: string) => `Switch to another profile first, then delete '${name}'.`,
    confirmTitle: 'Delete profile',
    confirmBody: (name: string) => `Permanently delete profile '${name}'. This cannot be undone.`,
    title: 'Delete complete',
    body: (name: string) => `Profile '${name}' deleted.`,
    errorTitle: 'Delete failed'
  },
  capture: {
    confirmTitle: 'Capture current live credentials',
    title: 'Capture complete',
    saved: (files: string) => `Saved: ${files}`,
    nothing: 'No live credentials to capture.',
    errorTitle: 'Capture failed'
  }
};
