/**
 * 입력값 검증자 모음. paths.ts 에서 분리 (path 합성과 검증의 mixed-concern 해체).
 *
 * 모든 validator 는 typeof string 가드를 가장 먼저 적용한다 — RegExp.test 가
 * 비문자열을 string 으로 강제 변환해 'null'/'undefined'/'true' 가 통과하는 corner
 * case 를 차단 (PR #10 quad-review Codex-2 합의).
 *
 * 검증 실패는 ValidationError 로 throw — UsageError 의 서브클래스라
 * cli.tsx top-level catch 가 자동으로 exit 2 매핑. `field` 필드로 어떤 입력이
 * 잘못됐는지 호출자가 식별 가능 (TUI inline 에러 표시 등).
 */

import { isAbsolute } from 'node:path';

import { ValidationError } from './errors.js';

/** filesystem 의 path segment 로 안전한 cli id 형식. 첫 글자는 영문, 이후 영문/숫자/`_`/`-` 만, 1~32자. */
const SAFE_CLI_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;

/** 프로필 이름 화이트리스트. 한글/영문/숫자 + _-. 만, 1~40자. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9가-힣_.-]{1,40}$/;

/** 디렉토리 traversal 위험으로 예약된 이름. */
const PROFILE_NAME_RESERVED = new Set<string>(['.', '..']);

/** 프로필 내 임의 파일명 화이트리스트. 영문/숫자/`.`/`_`/`-` 만 1~64자. */
const PROFILE_FILE_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** 세션 id 화이트리스트. 영문/숫자/`_`/`-` 만 1~64자 (`.` 불허 → traversal·예약명 원천 차단). */
const SESSION_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 파일명도 예약된 단독 `.`/`..` 는 별도 차단. */
const PROFILE_FILE_NAME_RESERVED = new Set<string>(['.', '..']);

/** SessionRoot.share 항목의 각 경로 세그먼트 화이트리스트. 영문/숫자/`.`/`_`/`-` 만. */
const SHARE_REL_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * cliId 가 path segment 로 안전한지 검증.
 * 비문자열 / traversal 가능 형식 (`..`, `/`, `\`, NUL) / regex 미매치 시 throw.
 *
 * 모든 path constructor 와 profile-store 가 공통으로 사용 —
 * findCliDef 결과를 신뢰할 수 있을 때도 defense-in-depth 로 한 번 더 검증한다.
 */
export function validateCliId(cliId: string): string {
  if (typeof cliId !== 'string') {
    throw new ValidationError('cliId 는 문자열이어야 합니다.', 'cliId');
  }
  if (!SAFE_CLI_ID_RE.test(cliId)) {
    throw new ValidationError(`cliId 가 path segment 로 사용 불가한 형식입니다: ${cliId}`, 'cliId');
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
    throw new ValidationError('프로필 이름은 문자열이어야 합니다.', 'profileName');
  }
  const name = rawName.normalize('NFC');
  if (PROFILE_NAME_RESERVED.has(name)) {
    throw new ValidationError('"." 또는 ".." 는 프로필 이름으로 사용할 수 없습니다.', 'profileName');
  }
  if (/[/\\\x00]/.test(name)) {
    throw new ValidationError('프로필 이름에 / \\ NUL 은 포함될 수 없습니다.', 'profileName');
  }
  if (!PROFILE_NAME_RE.test(name)) {
    throw new ValidationError(
      '프로필 이름은 한글/영문/숫자/_-. 만 사용 가능하며 1~40자 이내여야 합니다.',
      'profileName'
    );
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
 *
 * NFC 정규화는 PROFILE_FILE_NAME_RE 가 ASCII-only 인 한 명목상 (no-op) 이다 —
 * 비-ASCII 입력은 정규화 전후 모두 regex fail 로 throw. 화이트리스트 확장 시
 * (한글 파일명 허용 등) 실질 정규화로 자동 전환된다.
 */
export function validateProfileFileName(rawFileName: string): string {
  if (typeof rawFileName !== 'string') {
    throw new ValidationError('프로필 파일명은 문자열이어야 합니다.', 'profileFileName');
  }
  const fileName = rawFileName.normalize('NFC');
  if (PROFILE_FILE_NAME_RESERVED.has(fileName)) {
    throw new ValidationError('"." 또는 ".." 는 프로필 파일명으로 사용할 수 없습니다.', 'profileFileName');
  }
  if (/[/\\\x00]/.test(fileName)) {
    throw new ValidationError('프로필 파일명에 / \\ NUL 은 포함될 수 없습니다.', 'profileFileName');
  }
  if (!PROFILE_FILE_NAME_RE.test(fileName)) {
    throw new ValidationError(
      '프로필 파일명은 영문/숫자/._- 만 사용 가능하며 1~64자 이내여야 합니다.',
      'profileFileName'
    );
  }
  return fileName;
}

/**
 * 세션 id 검증 (validateProfileName 패턴 미러 — typeof guard → traversal 차단 → RE).
 * 세션 디렉토리 path segment 로 직접 쓰이므로 traversal-safe 해야 한다.
 *
 * id 는 `<cliId>-<profileName>-<rand8>` 형태로 mat 내부에서 생성되지만, `mat session
 * stop <id>` 처럼 사용자 입력으로도 들어오므로 사용 시점에 검증한다.
 * `.` 을 화이트리스트에서 제외해 `.`/`..` 예약명과 확장자 우회를 한 번에 차단한다.
 */
export function validateSessionId(rawId: string): string {
  if (typeof rawId !== 'string') {
    throw new ValidationError('세션 id 는 문자열이어야 합니다.', 'sessionId');
  }
  if (/[/\\\x00]/.test(rawId)) {
    throw new ValidationError('세션 id 에 / \\ NUL 은 포함될 수 없습니다.', 'sessionId');
  }
  if (!SESSION_ID_RE.test(rawId)) {
    throw new ValidationError(
      '세션 id 는 영문/숫자/_- 만 사용 가능하며 1~64자 이내여야 합니다.',
      'sessionId'
    );
  }
  return rawId;
}

/**
 * SessionRoot.share 항목 (base 상대경로) 의 traversal-safe 검증.
 *
 * share 는 격리 세션 디렉토리와 실제 base 양쪽에 `join(dir, shareRel)` 로 합성되므로,
 * 검증 없이는 `../x`/절대경로/구분자 우회로 세션 root 밖을 가리킬 수 있다 (allow-list 가
 * 켜지는 순간 fail-open). 빌트인 메타는 codex `config.toml` 을 share 로 쓰며(copy-isolate,
 * #72), plan 단계에서 traversal 을 차단한다 (quad-review PR #61 Codex/Claude MEDIUM 합의).
 *
 * 규칙: 비문자열/빈문자열/NUL/절대경로 거부. `\` 를 `/` 와 동일 구분자로 취급(Windows)하고,
 * 각 세그먼트는 비어있지 않고 `.`/`..` 가 아니며 SHARE_REL_SEGMENT_RE 매치여야 한다.
 * 정규화된(슬래시 통일) 상대경로를 반환한다.
 */
export function validateShareRel(rawRel: string): string {
  if (typeof rawRel !== 'string') {
    throw new ValidationError('share 항목은 문자열이어야 합니다.', 'shareRel');
  }
  if (rawRel === '') {
    throw new ValidationError('share 항목은 빈 문자열일 수 없습니다.', 'shareRel');
  }
  if (/\x00/.test(rawRel)) {
    throw new ValidationError('share 항목에 NUL 은 포함될 수 없습니다.', 'shareRel');
  }
  if (isAbsolute(rawRel)) {
    throw new ValidationError(`share 항목은 절대경로일 수 없습니다: ${rawRel}`, 'shareRel');
  }
  // 백슬래시도 구분자로 취급 — Windows 경로 우회 차단 (Antigravity LOW).
  const normalized = rawRel.replace(/\\/g, '/');
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') {
      throw new ValidationError(
        `share 항목에 빈/'.'/'..' 세그먼트는 허용되지 않습니다: ${rawRel}`,
        'shareRel'
      );
    }
    if (!SHARE_REL_SEGMENT_RE.test(seg)) {
      throw new ValidationError(
        `share 항목 세그먼트는 영문/숫자/._- 만 사용 가능합니다: ${rawRel}`,
        'shareRel'
      );
    }
  }
  return normalized;
}
import type { Source } from './types.js';

/** Profile artifact names are a namespace, not user-controlled live paths. */
export function assertValidSourceList(sources: Source[]): void {
  const seen = new Set<string>();
  for (const source of sources) {
    const saveAs = validateProfileFileName(source.saveAs);
    const canonical = saveAs.normalize('NFC').toLocaleLowerCase('en-US');
    if (saveAs === 'meta.json' || saveAs === 'identity.json' || /\.recap-[0-9a-f]+$/i.test(saveAs)) {
      throw new Error(`reserved profile artifact name: ${saveAs}`);
    }
    if (seen.has(canonical)) throw new Error(`duplicate profile artifact name: ${saveAs}`);
    seen.add(canonical);
  }
}
