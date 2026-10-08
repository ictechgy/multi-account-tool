import type { Messages } from '../en.js';

/** 한국어 메시지 — `coreValidation` 영역. */
export const coreValidation: Messages['coreValidation'] = {
  // validators.ts — cliId
  cliIdNotString: 'cliId 는 문자열이어야 합니다.',
  cliIdInvalidFormat: (cliId) => `cliId 가 path segment 로 사용 불가한 형식입니다: ${cliId}`,
  // validators.ts — 프로필 이름
  profileNameNotString: '프로필 이름은 문자열이어야 합니다.',
  profileNameReserved: '"." 또는 ".." 는 프로필 이름으로 사용할 수 없습니다.',
  profileNameForbiddenChars: '프로필 이름에 / \\ NUL 은 포함될 수 없습니다.',
  profileNameInvalidFormat: '프로필 이름은 한글/영문/숫자/_-. 만 사용 가능하며 1~40자 이내여야 합니다.',
  // validators.ts — 프로필 파일명
  profileFileNameNotString: '프로필 파일명은 문자열이어야 합니다.',
  profileFileNameReserved: '"." 또는 ".." 는 프로필 파일명으로 사용할 수 없습니다.',
  profileFileNameForbiddenChars: '프로필 파일명에 / \\ NUL 은 포함될 수 없습니다.',
  profileFileNameInvalidFormat: '프로필 파일명은 영문/숫자/._- 만 사용 가능하며 1~64자 이내여야 합니다.',
  // validators.ts — 세션 id
  sessionIdNotString: '세션 id 는 문자열이어야 합니다.',
  sessionIdForbiddenChars: '세션 id 에 / \\ NUL 은 포함될 수 없습니다.',
  sessionIdInvalidFormat: '세션 id 는 영문/숫자/_- 만 사용 가능하며 1~64자 이내여야 합니다.',
  // validators.ts — share 항목
  shareRelNotString: 'share 항목은 문자열이어야 합니다.',
  shareRelEmpty: 'share 항목은 빈 문자열일 수 없습니다.',
  shareRelNul: 'share 항목에 NUL 은 포함될 수 없습니다.',
  shareRelAbsolute: (rel) => `share 항목은 절대경로일 수 없습니다: ${rel}`,
  shareRelBadSegment: (rel) => `share 항목에 빈/'.'/'..' 세그먼트는 허용되지 않습니다: ${rel}`,
  shareRelSegmentChars: (rel) => `share 항목 세그먼트는 영문/숫자/._- 만 사용 가능합니다: ${rel}`,
  // profile-store.ts
  profileAlreadyExists: (name) => `이미 존재하는 프로필입니다: ${name}`,
  profileNameAlreadyExists: (name) => `이미 존재하는 프로필 이름입니다: ${name}`,
  stagingPathUnexpected: 'staging 경로가 예상 패턴(<file>.recap-<hex>)이 아닙니다 (commit 거부).',
  stagingNotRegularFile: 'staging 이 일반 파일이 아닙니다 (symlink/디렉토리 등 — commit 거부).',
  // migrate.ts
  migrateBothDirsExist: (legacy, current) =>
    `경고: 옛 데이터 디렉토리 (${legacy}) 와 새 디렉토리 (${current}) 가 둘 다 존재합니다.\n` +
    `수동으로 한쪽을 정리하거나 병합한 뒤 다시 실행하세요.`,
  migrateDone: (legacy, current) => `✓ 데이터 디렉토리 마이그레이션 완료: ${legacy} → ${current}`,
  migrateFailed: (legacy, detail) => `경고: 데이터 디렉토리 마이그레이션 실패 — 수동 확인 필요 (${legacy}): ${detail}`,
  // app/log.ts — 줄바꿈은 호출부가 붙인다
  appLogWriteFailedRetry: (detail) => `[mat] appLog 쓰기 실패 (mkdir retry): ${detail}`,
  appLogWriteFailed: (detail) => `[mat] appLog 쓰기 실패: ${detail}`
};
