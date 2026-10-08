/** 영어 메시지 — `coreValidation` 영역. 키 구조가 기준 스키마이며 ko/coreValidation.ts 가 같은 키를 가져야 한다. */
export const coreValidation = {
  // validators.ts — cliId
  cliIdNotString: 'cliId must be a string.',
  cliIdInvalidFormat: (cliId: string) => `cliId has a format that cannot be used as a path segment: ${cliId}`,
  // validators.ts — 프로필 이름
  profileNameNotString: 'Profile name must be a string.',
  profileNameReserved: '"." or ".." cannot be used as a profile name.',
  profileNameForbiddenChars: 'Profile name cannot contain / \\ or NUL.',
  profileNameInvalidFormat:
    'Profile name may only use Hangul, English letters, digits, and _-. and must be 1-40 characters long.',
  // validators.ts — 프로필 파일명
  profileFileNameNotString: 'Profile file name must be a string.',
  profileFileNameReserved: '"." or ".." cannot be used as a profile file name.',
  profileFileNameForbiddenChars: 'Profile file name cannot contain / \\ or NUL.',
  profileFileNameInvalidFormat:
    'Profile file name may only use English letters, digits, and ._- and must be 1-64 characters long.',
  // validators.ts — 세션 id
  sessionIdNotString: 'Session id must be a string.',
  sessionIdForbiddenChars: 'Session id cannot contain / \\ or NUL.',
  sessionIdInvalidFormat:
    'Session id may only use English letters, digits, and _- and must be 1-64 characters long.',
  // validators.ts — share 항목
  shareRelNotString: 'Share entry must be a string.',
  shareRelEmpty: 'Share entry cannot be an empty string.',
  shareRelNul: 'Share entry cannot contain NUL.',
  shareRelAbsolute: (rel: string) => `Share entry cannot be an absolute path: ${rel}`,
  shareRelBadSegment: (rel: string) => `Empty, '.' or '..' segments are not allowed in a share entry: ${rel}`,
  shareRelSegmentChars: (rel: string) =>
    `Share entry segments may only use English letters, digits, and ._-: ${rel}`,
  // profile-store.ts
  profileAlreadyExists: (name: string) => `Profile already exists: ${name}`,
  profileNameAlreadyExists: (name: string) => `Profile name already exists: ${name}`,
  stagingPathUnexpected: 'Staging path does not match the expected pattern (<file>.recap-<hex>) (commit refused).',
  stagingNotRegularFile: 'Staging is not a regular file (symlink, directory, etc. — commit refused).',
  // migrate.ts
  migrateBothDirsExist: (legacy: string, current: string) =>
    `Warning: both the old data directory (${legacy}) and the new directory (${current}) exist.\n` +
    `Clean up or merge one of them manually, then run again.`,
  migrateDone: (legacy: string, current: string) => `✓ Data directory migration complete: ${legacy} → ${current}`,
  migrateFailed: (legacy: string, detail: string) =>
    `Warning: data directory migration failed — check manually (${legacy}): ${detail}`,
  // app/log.ts — 줄바꿈은 호출부가 붙인다
  appLogWriteFailedRetry: (detail: string) => `[mat] appLog write failed (mkdir retry): ${detail}`,
  appLogWriteFailed: (detail: string) => `[mat] appLog write failed: ${detail}`
};
