import type { Messages } from '../en.js';

/** 한국어 메시지 — `app` 영역. */
export const app: Messages['app'] = {
  header: {
    subtitle: '여러 AI CLI 계정을 하나의 TUI 에서 전환'
  },
  none: '(없음)',
  unknownCli: '알 수 없는 CLI...',
  prompts: {
    newProfileName: (cliName: string) => `${cliName} — 새 프로필 이름`,
    renameTo: (cliName: string, oldName: string) => `${cliName} / ${oldName} → 새 이름`
  },
  firstImport: {
    title: '초기 자격증명 가져오기',
    importAll: '모두 가져오기',
    skip: '건너뛰기'
  },
  busy: {
    checkingCredentials: '자격증명 상태 확인 중...',
    importingCredentials: '자격증명 가져오는 중...',
    switching: '전환 중...',
    recaptureAndSwitch: '라이브 재캡처 후 전환 중...',
    discardAndSwitch: '라이브 폐기 후 전환 중...',
    switchingToNewAccount: '새 계정 프로필로 전환 중...',
    creatingProfile: '프로필 생성 중...',
    recaptureAndCreate: '라이브 재캡처 후 프로필 생성 중...',
    renaming: '이름 변경 중...',
    deleting: '삭제 중...',
    capturing: '캡처 중...'
  },
  switchConfirmTitle: (cliName: string) => `${cliName} 프로필 전환`,
  freshness: {
    checkFailedTitle: '자격증명 확인 실패',
    inflightTitle: '자격증명 갱신 중 (재시도 권장)',
    inflightBody:
      `라이브 자격증명이 갱신 중간 상태로 보입니다 (multi-source 부분 갱신).\n` +
      `잠시 후 다시 시도하세요.`
  },
  activeChanged: {
    title: '활성 프로필 변경 감지 — 작업 취소',
    body: (expected: string, current: string) =>
      `dialog 표시 중 다른 도구가 활성 프로필을 변경했습니다.\n` +
      `예상: '${expected}' / 현재: '${current}'\n\n` +
      `라이브 자격증명이 의도와 다른 프로필에 쓰일 수 있어 작업을 취소했습니다.\n` +
      `프로필 목록을 다시 확인 후 재시도하세요.`
  },
  firstImportChanged: (cliId: string, expected: string, current: string) =>
    `초기 가져오기 dialog 표시 중 ${cliId} 프로필 목록이 변경되었습니다.\n` +
    `예상: ${expected} / 현재: ${current}\n\n` +
    `다른 작업이 먼저 프로필 상태를 변경해 stale 가져오기를 취소했습니다.\n` +
    `프로필 목록을 다시 확인 후 재시도하세요.`,
  switchDone: {
    title: '전환 완료',
    errorTitle: '전환 실패'
  },
  recaptureSwitch: {
    title: '재캡처 + 전환 완료',
    body: (currentActive: string, to: string) =>
      `라이브 자격증명을 '${currentActive}' 에 저장한 뒤 '${to}' 로 전환했습니다.`,
    errorTitle: '재캡처/전환 실패'
  },
  discardSwitch: {
    title: '폐기 + 전환 완료',
    body: (to: string) => `라이브 자격증명을 백업 없이 폐기하고 '${to}' 로 전환했습니다.`,
    errorTitle: '폐기/전환 실패'
  },
  freshSwitch: {
    title: '새 계정 프로필로 전환 완료',
    discarded: '라이브 자격증명을 백업 없이 폐기했습니다.',
    errorTitle: '새 계정 프로필 전환 실패'
  },
  create: {
    title: '프로필 생성 완료',
    body: (name: string) => `'${name}' 프로필이 생성되었습니다. (활성 프로필은 변경되지 않았습니다)`,
    captured: (files: string) => `라이브 자격증명을 캡처했습니다: ${files}`,
    empty: '라이브 자격증명이 없어 빈 프로필로 생성되었습니다.',
    errorTitle: '프로필 생성 실패'
  },
  recaptureCreate: {
    title: '재캡처 + 프로필 생성 완료',
    body: (currentActive: string, newName: string) =>
      `라이브 자격증명을 '${currentActive}' 에 저장한 뒤 '${newName}' 프로필을 생성했습니다.`,
    keptActive: (currentActive: string) => `(활성 프로필은 '${currentActive}' 로 유지됩니다)`,
    capturedFiles: (files: string) => `캡처된 파일: ${files}`,
    errorTitle: '재캡처/생성 실패'
  },
  rename: {
    title: '이름 변경 완료',
    errorTitle: '이름 변경 실패'
  },
  delete: {
    activeTitle: '활성 프로필은 삭제할 수 없습니다',
    activeBody: (name: string) => `먼저 다른 프로필로 전환한 후 '${name}' 을 삭제하세요.`,
    confirmTitle: '프로필 삭제',
    confirmBody: (name: string) => `'${name}' 프로필을 영구 삭제합니다. 되돌릴 수 없습니다.`,
    title: '삭제 완료',
    body: (name: string) => `'${name}' 프로필이 삭제되었습니다.`,
    errorTitle: '삭제 실패'
  },
  capture: {
    confirmTitle: '현재 라이브 자격증명을 캡처',
    title: '캡처 완료',
    saved: (files: string) => `저장됨: ${files}`,
    nothing: '캡처할 라이브 자격증명이 없습니다.',
    errorTitle: '캡처 실패'
  }
};
