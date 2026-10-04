import type { Messages } from '../en.js';

/** 한국어 메시지 — `screens` 영역. */
export const screens: Messages['screens'] = {
  home: {
    title: '  CLI 를 선택하세요:',
    hints: '  ↑↓ 이동  ↵ 선택  q 종료',
    active: (name: string) => `활성: ${name}`,
    noActive: '활성: -',
    live: '✓ live',
    noLive: '⚠ live 없음',
    profileCount: (n: number) => `${n}개 프로필`,
    noProfiles: '프로필 없음'
  },
  profiles: {
    activeProfile: (name: string) => `  활성 프로필: ${name}`,
    none: '(없음)',
    empty: "  프로필이 없습니다. 'a' 키로 새 프로필을 추가하세요.",
    hintsLine1: '  ↵ 이 프로필로 전환    c 캡처(라이브→프로필)    a 새 프로필',
    hintsLine2: '  r 이름 변경    d 삭제    esc 뒤로',
    activeMark: ' (활성)',
    pendingMark: ' · 로그인 대기'
  },
  relative: {
    justNow: '방금',
    minutesAgo: (n: number) => `${n}분 전`,
    hoursAgo: (n: number) => `${n}시간 전`,
    daysAgo: (n: number) => `${n}일 전`,
    monthsAgo: (n: number) => `${n}달 전`
  },
  addMode: {
    title: (cliName: string, name: string) => `  ${cliName} — '${name}' 프로필을 어떻게 시작할까요?`,
    fresh: '새 계정으로 시작 — 로그아웃 상태로 만들고 바로 전환',
    copy: '현재 로그인 복사 — 지금 로그인된 계정을 이 프로필로 저장',
    noteLine1: '  새 계정: 지금 계정은 활성 프로필에 저장되고 CLI 가 로그아웃됩니다.',
    noteLine2: '          새 계정으로 로그인하면 다음 전환 때 이 프로필에 저장됩니다.',
    hints: '  ↑↓ 이동  ↵ 선택  esc 취소'
  },
  freshness: {
    titleStale: '라이브 자격증명이 저장본과 크게 다릅니다 (다른 계정 추정)',
    titleRotated: '라이브 자격증명이 갱신되었습니다 (refresh rotation)',
    activeProfileLabel: '  활성 프로필: ',
    targetLabel: '  대상: ',
    modeSwitch: ' (전환 중)',
    modeCreate: ' (새 프로필 생성 중)',
    recaptureOption: '  [R/↵] 재캡처',
    recaptureBodySwitch: (from: string) => `        라이브를 '${from}' 에 저장한 뒤 전환 (권장)`,
    recaptureBodyCreate: (from: string) => `        라이브를 '${from}' 에 저장한 뒤 새 프로필 생성 (권장)`,
    discardOption: '  [D] 폐기',
    discardBodySwitch: (to: string) => `        라이브를 백업 없이 폐기하고 '${to}' 로 전환 (데이터 손실)`,
    discardBodyCreate: (from: string, to: string) =>
      `        라이브를 '${from}' 에 저장하지 않고 '${to}' 만 생성 (현재 저장본 stale 유지)`,
    cancelOption: '  [C/esc] 취소'
  },
  onboarding: {
    title: '처음 보시는 안내',
    line1: 'OAuth 기반 CLI 는 사용 중 refresh token rotation 으로 라이브 자격증명을 자동 갱신합니다.',
    line2: 'mat 의 저장본은 그 갱신을 모르므로 그대로 전환하면 옛 토큰이 라이브로 복원되어',
    line3: 'provider 가 강제 재로그인을 요구할 수 있습니다.',
    line4Before: '보통은 ',
    line4Emphasis: '재캡처',
    line4After: '가 안전합니다. 본 안내는 다음 표시부터 생략됩니다.'
  }
};
