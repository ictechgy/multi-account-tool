import type { Messages } from '../en.js';

/** 한국어 메시지 — `formatters` 영역. */
export const formatters: Messages['formatters'] = {
  firstImport: {
    intro: `다음 CLI 에 이미 로그인된 자격증명이 감지되었습니다:\n`,
    outro:
      `\n\n각 CLI 마다 'default' 프로필로 가져올까요?\n` +
      `라이브 자격증명은 그대로 유지되며 백업만 생성됩니다.\n` +
      `(이 프롬프트는 어떤 답을 선택하든 다음 실행부터 자동으로 뜨지 않습니다.)`,
    titleSuccess: '가져오기 완료',
    titleError: '가져오기 실패',
    titlePartial: '가져오기 부분 완료',
    successLine: (cliId: string, captured: string[]) =>
      `✓ ${cliId}: ${captured.length}개 파일 캡처 (${captured.join(', ')})`
  },
  switchConfirm: {
    none: '(없음)',
    noActive: (to: string) =>
      `현재 활성 프로필이 없어 별도 백업 없이 '${to}' 프로필을 복원합니다.\n` +
      `(주의: 현재 라이브 자격증명은 덮어써집니다)`,
    withBackup: (currentActive: string, to: string) =>
      `현재 라이브 자격증명은 '${currentActive}' 프로필로 자동 백업된 뒤,\n` +
      `'${to}' 프로필의 자격증명이 복원됩니다.`
  },
  switchResult: {
    backup: (profileName: string, n: number) => `백업 → ${profileName} : ${n}개 파일`,
    emptyNotCaptured: (list: string) => `  (비어있어 캡처 안 됨: ${list})`,
    notEvaluatedAlreadyActive: (to: string) => `이미 활성인 프로필입니다 — 복원을 수행하지 않았습니다: ${to}`,
    notEvaluatedCarryOver:
      `  이번 호출은 이월 여부를 판정하지 않았습니다. 'mat doctor' / 'mat freshness' 로 확인하세요.`,
    clearedSwitched: (to: string, list: string) =>
      `로그아웃 상태로 전환했습니다 → ${to} (지운 라이브 자격증명: ${list})`,
    clearedLogin: `  → 이제 CLI 에서 새 계정으로 로그인하세요.`,
    clearedAutoSave: (to: string) =>
      `  → 로그인한 계정은 다음 전환 때 '${to}' 에 자동 저장됩니다 (바로 저장하려면 'c' 캡처).`,
    restore: (to: string, n: number) => `복원 → ${to} : ${n}개 파일`,
    missingSkipped: (list: string) => `  (프로필에 없어 건너뜀: ${list})`,
    carryOverWarning: (list: string) => `  ⚠ 이전 계정 자격증명이 라이브에 그대로 남아 있습니다: ${list}`,
    carryOverDoNotRecapture: (to: string) =>
      `    → 지금 ${to} 를 재캡처하면 다른 계정의 자격증명이 ${to} 에 저장됩니다. 재캡처하지 마세요.`,
    carryOverAfterRelogin: (to: string) =>
      `    → ${to} 계정으로 다시 로그인한 뒤에는 ${to} 재캡처가 올바른 조치입니다.`,
    carryOverCheckFirst:
      `    → 라이브 값이 어느 계정 것인지는 'mat freshness' / 'mat doctor' 로 먼저 확인하세요.`
  },
  captureWarning: {
    overwrite: (name: string) => `'${name}' 프로필의 저장된 자격증명을 현재 라이브 값으로 덮어씁니다.`,
    sameActiveHint: '방금 새 계정으로 로그인을 마쳤다면 이 동작을 사용하세요.',
    mismatch: (name: string, active: string | undefined) =>
      `⚠ 주의: 현재 활성 프로필은 '${active ?? '없음'}' 입니다.\n` +
      `라이브 자격증명은 활성 프로필의 것이므로, 캡처 시 '${name}' 프로필이\n` +
      `활성 프로필의 자격증명으로 덮어써집니다 (의도한 동작이 맞는지 확인하세요).`
  }
};
