/**
 * 데이터 디렉토리 및 경로 헬퍼.
 * 모든 프로필은 ~/.multi-account-tool 아래에 보관된다.
 *
 * 입력값 검증자는 validators.ts 로 분리 (path 합성과 검증의 mixed-concern 해체).
 * 기존 호출자 호환을 위해 validateCliId / validateProfileName / validateProfileFileName
 * 은 이 모듈에서 re-export 유지.
 *
 * 모든 path constructor (cliProfilesDir / profileDir / profileFilePath /
 * profileMetaPath / cliLockPath) 는 입력값을 자체 검증한다. 호출자가 우회로 paths.ts
 * 를 직접 import 해도 traversal escape 가 불가하다 (PR #10 quad-review Codex-1 합의).
 */

import { homedir } from 'node:os';
import { join, normalize } from 'node:path';

import {
  validateCliId,
  validateProfileFileName,
  validateProfileName,
  validateSessionId,
  validateShareRel
} from './validators.js';

export {
  validateCliId,
  validateProfileFileName,
  validateProfileName,
  validateSessionId,
  validateShareRel
};

const DATA_DIR_NAME = '.multi-account-tool';

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

/**
 * 특정 CLI 의 프로필 루트. cliId 자체 검증 (직접 호출자 우회 차단).
 * NOTE: profileDir 도 동일 cliId 를 명시 검증한다 (위임 fragility 제거 — 양쪽 동기화 필요).
 */
export function cliProfilesDir(cliId: string): string {
  const safeCli = validateCliId(cliId);
  return join(profilesDir(), safeCli);
}

/**
 * 특정 CLI/프로필의 디렉토리. cliId + profileName 자체 검증.
 * profileName 은 NFC 정규화 결과로 경로 구성 (디스크 단일 표기 통일).
 *
 * cliId 검증은 cliProfilesDir 위임으로도 일어나지만, 향후 inline 화 등 refactor 시
 * 위임이 끊겨도 안전하도록 명시 재호출. validateCliId 비용은 regex 1회 + 길이/예약명
 * 체크 ~ microsecond 미만 → 중복 호출 비용 대비 refactor 안전성 이득이 큼.
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

/** 세션 격리 디렉토리 루트 (`mat session` 의 세션별 자격증명 격리용). */
export function sessionsDir(): string {
  return join(dataDir(), 'sessions');
}

/** 특정 세션의 디렉토리. sessionId 자체 검증 (직접 호출자 traversal 차단). */
export function sessionDir(id: string): string {
  const safeId = validateSessionId(id);
  return join(sessionsDir(), safeId);
}

/**
 * TUI 의 best-effort 경고 / 로그 한 줄을 쌓는 파일.
 *
 * 도입 (PR-R): Ink alternate-buffer 모드에서 `process.stderr.write` 가 화면 렌더와
 * 충돌 가능 (PR-G Claude-1 LOW finding). best-effort 정보 (예: persist 실패) 는
 * stderr 대신 본 파일에 append → 사용자 경험 무영향 + 디버그 audit trail 보존.
 */
export function appLogPath(): string {
  return join(dataDir(), 'app.log');
}

/** 안정 JSONL 감사 로그 경로 (session lifecycle observability). */
export function auditLogPath(): string {
  return join(dataDir(), 'audit.jsonl');
}

/** 특정 CLI 의 lock 디렉토리 경로 (mkdir-lock 패턴). cliId 자체 검증. */
export function cliLockPath(cliId: string): string {
  const safeCli = validateCliId(cliId);
  return join(locksDir(), `${safeCli}.lock`);
}

/**
 * 프로필 단위 재캡처 advisory 락 디렉토리 경로 (`mat session` 종료 재캡처 직렬화용, issue #62).
 *
 * cliId 와 profileName 을 **각각 검증한 뒤 별도 세그먼트**로 join 한다 — `'a-b'`/`'c'` 와
 * `'a'`/`'b-c'` 가 단일 문자열로 합쳐질 때 발생하는 경로 충돌을 중첩 디렉토리로 차단한다.
 * `mat exec` 의 `locks/<cli>.lock` 과는 **별도 namespace**(`locks/recapture/...`)라 exec 의
 * cli-lock 과 절대 같은 경로를 만들지 않아 세션 동시성을 깨지 않는다 (LockHeldError 충돌 회피).
 */
export function recaptureLockPath(cliId: string, profileName: string): string {
  const safeCli = validateCliId(cliId);
  const safeProfile = validateProfileName(profileName);
  return join(locksDir(), 'recapture', safeCli, `${safeProfile}.lock`);
}

/** 선행 `~/` 를 home 으로 확장. 그 외 경로는 그대로 반환. */
export function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

/**
 * 확장 후 표기가 이미 정규형인지 — 즉 `normalize` 가 아무것도 바꾸지 않는지.
 *
 * `expandTilde` 는 `~/` 경로를 `join` 으로 확장하고 `join` 은 `normalize` 를 포함하므로
 * `~/` 리터럴은 **구조적으로 항상** 정규형이다. 따라서 이 검사가 실제로 걸러내는 것은
 * `..`/`.`/중복 슬래시를 포함한 **비-틸데 절대 경로**뿐이다.
 *
 * **왜 이걸 거부해야 하는가**: 비정규 표기를 받아들이면 안전성 판정은 정규형 문자열로,
 * 실제 파일 I/O 는 원형 문자열로 이뤄진다. 그러면 부모 디렉토리 identity 를 pinning 하는
 * 검사(`sources.ts` 의 provider 경로)에서 두 문자열이 어긋나 정상 경로인데도
 * TOCTOU 를 암시하는 오류로 실패한다. 판정과 I/O 대상을 같은 문자열로 유지하는 것이
 * 하드닝 계약의 전제다.
 */
export function isNormalizedPathSpelling(p: string): boolean {
  const expanded = expandTilde(p);
  return normalize(expanded) === expanded;
}
