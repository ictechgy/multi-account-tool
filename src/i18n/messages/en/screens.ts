/** 영어 메시지 — `screens` 영역. 키 구조가 기준 스키마이며 ko/screens.ts 가 같은 키를 가져야 한다. */
export const screens = {
  home: {
    title: '  Select a CLI:',
    hints: '  ↑↓ move  ↵ select  q quit',
    /** formatCliLabel 의 열 — 호출부에서 padEnd 로 정렬한다. */
    active: (name: string) => `active: ${name}`,
    noActive: 'active: -',
    live: '✓ live',
    noLive: '⚠ no live',
    profileCount: (n: number) => `${n} ${n === 1 ? 'profile' : 'profiles'}`,
    noProfiles: 'no profiles'
  },
  profiles: {
    activeProfile: (name: string) => `  active profile: ${name}`,
    none: '(none)',
    empty: "  No profiles. Press 'a' to add a new profile.",
    hintsLine1: '  ↵ switch to this profile    c capture (live→profile)    a new profile',
    hintsLine2: '  r rename    d delete    esc back',
    activeMark: ' (active)',
    pendingMark: ' · awaiting login'
  },
  relative: {
    justNow: 'just now',
    minutesAgo: (n: number) => `${n}m ago`,
    hoursAgo: (n: number) => `${n}h ago`,
    daysAgo: (n: number) => `${n}d ago`,
    monthsAgo: (n: number) => `${n}mo ago`
  },
  addMode: {
    title: (cliName: string, name: string) => `  ${cliName} — how do you want to start profile '${name}'?`,
    fresh: 'Start with a new account — log out and switch right away',
    copy: 'Copy current login — save the logged-in account to this profile',
    noteLine1: '  New account: backs up the current login, then logs the CLI out.',
    noteLine2: '               Log in with the new account; it is saved on your next switch.',
    hints: '  ↑↓ move  ↵ select  esc cancel'
  },
  freshness: {
    titleStale: 'Live credentials differ greatly from the saved copy (likely a different account)',
    titleRotated: 'Live credentials were renewed (refresh rotation)',
    activeProfileLabel: '  active profile: ',
    targetLabel: '  target: ',
    modeSwitch: ' (switching)',
    modeCreate: ' (creating new profile)',
    recaptureOption: '  [R/↵] Recapture',
    recaptureBodySwitch: (from: string) => `        Save live to '${from}', then switch (recommended)`,
    recaptureBodyCreate: (from: string) => `        Save live to '${from}', then create new profile (recommended)`,
    discardOption: '  [D] Discard',
    discardBodySwitch: (to: string) => `        Discard live without a backup and switch to '${to}' (data loss)`,
    discardBodyCreate: (from: string, to: string) =>
      `        Create only '${to}' without saving live to '${from}' (saved copy stays stale)`,
    cancelOption: '  [C/esc] Cancel'
  },
  onboarding: {
    title: 'First-time notice',
    line1: 'OAuth-based CLIs renew live credentials during use (refresh token rotation).',
    line2: "mat's saved copy misses these renewals, so switching as-is restores the old token",
    line3: 'to live, and the provider may force you to log in again.',
    /** line4 는 `before` + 굵은 `emphasis` + `after` 로 렌더링된다. */
    line4Before: 'Usually ',
    line4Emphasis: 'recapture',
    line4After: ' is the safe choice. This notice will not be shown again.'
  }
};
