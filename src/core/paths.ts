/**
 * 데이터 디렉토리 및 경로 헬퍼 + 입력값 검증자.
 * 모든 프로필은 ~/.multi-account-tool 아래에 보관된다.
 *
 * 모든 path constructor (cliProfilesDir / profileDir / profileFilePath /
 * profileMetaPath / cliLockPath) 는 입력값을 자체 검증한다. 호출자가 우회로 paths.ts
 * 를 직접 import 해도 traversal escape 가 불가하다 (PR #10 quad-review Codex-1 합의).
 *
 * 검증자는 외부 typeof 우회 (`unknown as string`, JSON 경계 등) 도 차단하기 위해
 * typeof string 가드를 가장 먼저 적용한다 (PR #10 quad-review Codex-2 합의).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

const DATA_DIR_NAME = '.multi-account-tool';

/** filesystem 의 path segment 로 안전한 cli id 형식. 첫 글자는 영문, 이후 영문/숫자/`_`/`-` 만, 1~32자. */
const SAFE_CLI_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

/** 프로필 이름 화이트리스트. 한글/영문/숫자 + _-. 만, 1~40자. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9가-힣_.-]{1,40}$/;

/** 디렉토리 traversal 위험으로 예약된 이름. */
const PROFILE_NAME_RESERVED = new Set<string>(['.', '..']);

/** 프로필 내 임의 파일명 화이트리스트. 영문/숫자/`.`/`_`/`-` 만 1~64자. */
const PROFILE_FILE_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** 파일명도 예약된 단독 `.`/`..` 는 별도 차단. */
const PROFILE_FILE_NAME_RESERVED = new Set<string>(['.', '..']);

/**
 * cliId 가 path segment 로 안전한지 검증.
 * 비문자열 / traversal 가능 형식 (`..`, `/`, `\`, NUL) / regex 미매치 시 throw.
 *
 * 모든 path constructor 와 profile-store 가 공통으로 사용 —
 * findCliDef 결과를 신뢰할 수 있을 때도 defense-in-depth 로 한 번 더 검증한다.
 */
export function validateCliId(cliId: string): string {
  if (typeof cliId !== 'string') {
    throw new Error('cliId 는 문자열이어야 합니다.');
  }
  if (!SAFE_CLI_ID_RE.test(cliId)) {
    throw new Error(`cliId 가 path segment 로 사용 불가한 형식입니다: ${cliId}`);
  }
  return cliId;
}

/**
 * 프로필 이름을 검증하고 NFC 정규화된 형태로 반환.
 * 비문자열 / 잘못된 입력은 throw.
 *
 * - typeof string 가드 (RegExp.test 의 비문자열 강제 변환 회피)
 * - NFC 정규화 (한글 NFD/NFC 우회로 동일 표기 두 프로필 생성 방지)
 * - `.`, `..` 명시 차단 (경로 traversal)
 * - `/`, `\`, NUL 명시 차단
 * - PROFILE_NAME_RE 매칭 (정규화 후 길이 1~40자)
 */
export function validateProfileName(rawName: string): string {
  if (typeof rawName !== 'string') {
    throw new Error('프로필 이름은 문자열이어야 합니다.');
  }
  const name = rawName.normalize('NFC');
  if (PROFILE_NAME_RESERVED.has(name)) {
    throw new Error('"." 또는 ".." 는 프로필 이름으로 사용할 수 없습니다.');
  }
  if (/[/\\\x00]/.test(name)) {
    throw new Error('프로필 이름에 / \\ NUL 은 포함될 수 없습니다.');
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error('프로필 이름은 한글/영문/숫자/_-. 만 사용 가능하며 1~40자 이내여야 합니다.');
  }
  return name;
}

/**
 * 프로필 내 임의 파일명 (source 의 saveAs) 검증.
 * 비문자열 / traversal 가능 형식 + 예약명 + 화이트리스트 미매치 시 throw.
 * 반환값은 NFC 정규화된 형태 (validateProfileName 과 대칭).
 *
 * 현재는 BUILTIN_CLI_DEFS 의 saveAs 만 호출 경로상 들어오지만, ROADMAP 의
 * CLI def plugin (`~/.multi-account-tool/cli-defs/*.json`) 도입 시 신뢰할 수 없는
 * 입력이 되므로 정의 단계가 아닌 사용 단계에서 마지막 방어선을 둔다.
 * 화이트리스트는 ASCII-only 이므로 NFC 정규화가 결과를 바꾸지 않지만,
 * validateProfileName 과의 일관성 + 검증 전 표준화 정책 표현 목적으로 적용.
 */
export function validateProfileFileName(rawFileName: string): string {
  if (typeof rawFileName !== 'string') {
    throw new Error('프로필 파일명은 문자열이어야 합니다.');
  }
  const fileName = rawFileName.normalize('NFC');
  if (PROFILE_FILE_NAME_RESERVED.has(fileName)) {
    throw new Error('"." 또는 ".." 는 프로필 파일명으로 사용할 수 없습니다.');
  }
  if (/[/\\\x00]/.test(fileName)) {
    throw new Error('프로필 파일명에 / \\ NUL 은 포함될 수 없습니다.');
  }
  if (!PROFILE_FILE_NAME_RE.test(fileName)) {
    throw new Error('프로필 파일명은 영문/숫자/._- 만 사용 가능하며 1~64자 이내여야 합니다.');
  }
  return fileName;
}

/** ~/.multi-account-tool 의 절대 경로 */
export function dataDir(): string {
  return join(homedir(), DATA_DIR_NAME);
}

/** 전역 설정 파일 경로 */
export function configPath(): string {
  return join(dataDir(), 'config.json');
}

/** 모든 프로필 루트 디렉토리 */
export function profilesDir(): string {
  return join(dataDir(), 'profiles');
}

/** 특정 CLI 의 프로필 루트. cliId 자체 검증 (직접 호출자 우회 차단). */
export function cliProfilesDir(cliId: string): string {
  const safeCli = validateCliId(cliId);
  return join(profilesDir(), safeCli);
}

/**
 * 특정 CLI/프로필의 디렉토리. cliId + profileName 자체 검증.
 * profileName 은 NFC 정규화 결과로 경로 구성 (디스크 단일 표기 통일).
 *
 * cliId 검증은 cliProfilesDir 위임으로도 일어나지만, 향후 inline 화 등 refactor 시
 * 위임이 끊겨도 안전하도록 명시 재호출 (idempotent, perf 무시 가능).
 */
export function profileDir(cliId: string, profileName: string): string {
  validateCliId(cliId);
  const safeName = validateProfileName(profileName);
  return join(cliProfilesDir(cliId), safeName);
}

/** 프로필 내 임의 파일. 세 입력 모두 자체 검증. */
export function profileFilePath(cliId: string, profileName: string, fileName: string): string {
  const safeFile = validateProfileFileName(fileName);
  return join(profileDir(cliId, profileName), safeFile);
}

/** 프로필 메타 파일 경로 (fileName 은 고정 'meta.json'). */
export function profileMetaPath(cliId: string, profileName: string): string {
  return profileFilePath(cliId, profileName, 'meta.json');
}

/** lockfile 들이 모이는 디렉토리 (`mat exec` 의 cli 별 직렬화용). */
export function locksDir(): string {
  return join(dataDir(), 'locks');
}

/** 특정 CLI 의 lock 디렉토리 경로 (mkdir-lock 패턴). cliId 자체 검증. */
export function cliLockPath(cliId: string): string {
  const safeCli = validateCliId(cliId);
  return join(locksDir(), `${safeCli}.lock`);
}

/** 선행 `~/` 를 home 으로 확장. 그 외 경로는 그대로 반환. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}
