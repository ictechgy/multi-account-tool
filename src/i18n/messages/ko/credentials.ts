import type { Messages } from '../en.js';

/** 한국어 메시지 — `credentials` 영역. */
export const credentials: Messages['credentials'] = {
  // errors.ts
  unknownCli: (cliId) => `알 수 없는 CLI: ${cliId}`,
  keychainAccountMissing: (displayService) =>
    `keychain service '${displayService}' 의 기존 항목 account 를 파악할 수 없어 안전 swap 을 거부합니다. ` +
    `service-only 삭제는 동일 service 의 타 항목까지 영향을 줄 수 있어 data loss 위험이 있습니다. ` +
    `Keychain Access.app 에서 해당 service 의 항목을 수동 정리 후 다시 시도하세요.`,
  keychainCommandFailed: (stage, exitCode, detail, suffix) =>
    `keychain ${stage} 실패 (code=${exitCode}): ${detail}${suffix}`,
  osKeyringAccountMissing: (displayService, matchCount) =>
    `os-keyring service '${displayService}' 에서 ` +
    (matchCount > 1
      ? `${matchCount} 개의 항목이 매칭되어(collision)`
      : `기존 항목의 account 를 식별할 수 없어`) +
    ` 안전 swap 을 거부합니다. ` +
    `secret-tool clear 는 매칭 항목을 전부 삭제하므로, account 를 확정하지 못한 채 진행하면 ` +
    `무관한 자격증명까지 손실될 수 있습니다. ` +
    `secret-tool 또는 keyring 관리 도구에서 해당 service 의 항목을 정리 후 다시 시도하세요.`,

  // sources.ts (macOS Keychain)
  keychainStages: {
    read: '읽기',
    deleteBackupEntry: '백업 항목 삭제',
    write: '쓰기'
  },
  unhandledSourceType: (type) => '처리되지 않은 source type: ' + type,
  keychainInvalidAccount: (displayService) =>
    `KeychainSource.account 가 유효하지 않습니다 (빈 문자열 / NUL 포함 등): service=${displayService}`,
  keychainRollbackFailed: (code, stderr) => ` / 백업 복구도 실패 (code=${code}): ${stderr}`,
  keychainMacOnly: 'keychain source 는 macOS 에서만 지원됩니다.',
  keychainBackupCorrupted: 'keychain backup 이 손상되었습니다: value 필드가 문자열이 아닙니다.',

  // os-keyring.ts (Linux Secret Service)
  osKeyringStages: {
    lookup: '조회',
    deleteEntry: '항목 삭제'
  },
  osKeyringInvalidAccount: (displayService) =>
    `OsKeyringSource.account 가 유효하지 않습니다 (빈 문자열 / NUL 포함 등): service=${displayService}`,
  osKeyringDaemonUnavailable: (stage, code) =>
    `os-keyring ${stage} 실패 (code=${code}): Secret Service keyring daemon 미응답 또는 접근 거부. ` +
    `gnome-keyring 등 keyring daemon 활성화를 확인하세요.`,
  osKeyringNotInstalled: (stage, bin) =>
    `os-keyring ${stage} 실패: secret-tool 이 미설치입니다 ` +
    `(${bin} 부재, ENOENT). libsecret-tools 패키지를 설치하거나, ` +
    `해당 CLI 가 file backend(평문 파일) 모드를 지원하면 그 모드로 전환하세요 (README 참고).`,
  osKeyringSpawnFailed: (stage, bin, errno) =>
    `os-keyring ${stage} 실패: secret-tool 을 실행할 수 없습니다 ` +
    `(${bin}, errno=${errno ?? '미상'}). 실행 권한 또는 바이너리 상태를 확인하세요.`,
  osKeyringParseFailed: 'os-keyring search 결과 파싱 실패: 1 블록인데 secret 을 추출하지 못했습니다.',
  osKeyringRollbackFailed: (code) => ` / 백업 복구도 실패 (code=${code})`,
  osKeyringWriteFailed: (code, rollbackNote) => `os-keyring 쓰기 실패 (code=${code})${rollbackNote}`,
  osKeyringBackupCorrupted: 'os-keyring backup 이 손상되었습니다: value 필드가 문자열이 아닙니다.',

  // switcher.ts
  doctorHint: (saveAs) => ` (${saveAs}; 'mat doctor' 로 확인)`,
  profileNotFound: (cliId, profileName) => `프로필을 찾을 수 없습니다: ${cliId}/${profileName}`,
  unsavedLiveCredentials: (cliId, liveSources) =>
    `현재 ${cliId} 로그인이 어떤 프로필에도 저장돼 있지 않아 로그아웃 상태로 전환할 수 없습니다 ` +
    `(라이브: ${liveSources}). 먼저 '현재 로그인 복사' 로 프로필을 만들어 저장하세요.`,
  freshnessCheckFailed: (cliId, profileName, message) =>
    `[mat] freshness 검사 실패 (swap 진행됨): cli=${cliId} profile=${profileName}: ${message}`
};
