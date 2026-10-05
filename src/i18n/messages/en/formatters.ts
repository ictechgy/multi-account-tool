/** 영어 메시지 — `formatters` 영역. 키 구조가 기준 스키마이며 ko/formatters.ts 가 같은 키를 가져야 한다. */

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

export const formatters = {
  firstImport: {
    /** 감지된 CLI 목록 앞에 오는 문구. 목록은 호출부가 `  - name` 줄로 붙인다. */
    intro: 'Existing logged-in credentials were detected for these CLIs:\n',
    /** 목록 뒤에 오는 문구 (앞의 빈 줄 포함). */
    outro:
      `\n\nImport each CLI's credentials as a 'default' profile?\n` +
      `Live credentials stay as they are; only a backup is created.\n` +
      `(Either way, this prompt won't appear automatically again.)`,
    titleSuccess: 'Import complete',
    titleError: 'Import failed',
    titlePartial: 'Import partially complete',
    successLine: (cliId: string, captured: string[]) =>
      `✓ ${cliId}: captured ${files(captured.length)} (${captured.join(', ')})`
  },
  switchConfirm: {
    none: '(none)',
    noActive: (to: string) =>
      `No active profile, so profile '${to}' will be restored without a separate backup.\n` +
      `(Warning: the current live credentials will be overwritten)`,
    withBackup: (currentActive: string, to: string) =>
      `The current live credentials will be backed up to profile '${currentActive}',\n` +
      `then the credentials of profile '${to}' will be restored.`
  },
  switchResult: {
    backup: (profileName: string, n: number) => `Backup → ${profileName} : ${files(n)}`,
    emptyNotCaptured: (list: string) => `  (empty, not captured: ${list})`,
    notEvaluatedAlreadyActive: (to: string) => `Profile is already active — no restore was performed: ${to}`,
    notEvaluatedCarryOver:
      `  This call did not check for carried-over credentials. Check with 'mat doctor' / 'mat freshness'.`,
    clearedSwitched: (to: string, list: string) =>
      `Switched to a logged-out state → ${to} (cleared live credentials: ${list})`,
    clearedLogin: `  → Now log in to the CLI with the new account.`,
    clearedAutoSave: (to: string) =>
      `  → Your new login is saved to '${to}' on the next switch (press 'c' to save it now).`,
    restore: (to: string, n: number) => `Restore → ${to} : ${files(n)}`,
    missingSkipped: (list: string) => `  (not in profile, skipped: ${list})`,
    carryOverWarning: (list: string) => `  ⚠ The previous account's credentials are still live: ${list}`,
    carryOverDoNotRecapture: (to: string) =>
      `    → Recapturing ${to} now would save another account's credentials to ${to}. Do not recapture it.`,
    carryOverAfterRelogin: (to: string) =>
      `    → After logging in again with the ${to} account, recapturing ${to} is the right step.`,
    carryOverCheckFirst:
      `    → First check which account the live values belong to with 'mat freshness' / 'mat doctor'.`
  },
  captureWarning: {
    overwrite: (name: string) => `Overwrites the saved credentials of profile '${name}' with the current live values.`,
    sameActiveHint: 'Use this if you just finished logging in with a new account.',
    mismatch: (name: string, active: string | undefined) =>
      `⚠ Warning: the current active profile is '${active ?? 'none'}'.\n` +
      `Live credentials belong to the active profile, so capturing will overwrite profile '${name}'\n` +
      `with the active profile's credentials (make sure this is what you intend).`
  }
};
