/**
 * 프로필 CRUD: 디스크 디렉토리/메타 파일 관리.
 * 자격증명 데이터 자체는 source 별 saveAs 파일에 저장되며,
 * 본 모듈은 read/write 헬퍼만 제공한다 (값의 해석은 source 모듈이 담당).
 *
 * 모든 파일 쓰기는 io-atomic 의 writeFileAtomic (O_EXCL + O_NOFOLLOW + 0600) 으로 통일.
 *
 * 모든 public 함수는 path traversal 방어를 위해 입력값을 내부에서 검증한다:
 *  - cliId  → validateCliId      (영문 시작 + 영숫자/`_`/`-` 1~32자)
 *  - name   → validateProfileName (NFC 정규화 + 예약명/구분자 차단 + 1~40자)
 *  - 파일명 → validateProfileFileName (영숫자/`.`/`_`/`-` 1~64자, 단독 `.`/`..` 차단)
 *
 * 검증된 NFC-정규화 결과를 path 구성에 사용해, 입력이 NFD/raw 였더라도
 * 디스크에는 단일 NFC 표기로 통일된다.
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './io-atomic.js';
import {
  cliProfilesDir,
  profileDir,
  profileFilePath,
  profileMetaPath,
  validateCliId
} from './paths.js';
import type { Profile } from './types.js';

/** 한글/영문/숫자 + _-. 만, 1~40자. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9가-힣_.-]{1,40}$/;

/** 디렉토리 traversal 위험으로 예약된 이름. */
const PROFILE_NAME_RESERVED = new Set<string>(['.', '..']);

/** 프로필 내 임의 파일명 화이트리스트. 영문/숫자/`.`/`_`/`-` 만 1~64자. */
const PROFILE_FILE_NAME_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** 파일명도 예약된 단독 `.`/`..` 는 별도 차단. */
const PROFILE_FILE_NAME_RESERVED = new Set<string>(['.', '..']);

/**
 * 프로필 이름을 검증하고 NFC 정규화된 형태로 반환.
 * 잘못된 입력은 throw.
 *
 * - NFC 정규화 (한글 NFD/NFC 우회로 동일 표기 두 프로필 생성 방지)
 * - `.`, `..` 명시 차단 (경로 traversal)
 * - `/`, `\`, NUL 명시 차단
 * - PROFILE_NAME_RE 매칭
 */
export function validateProfileName(rawName: string): string {
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
 * traversal 가능 형식 (`..`, `/`, `\`, NUL) + 예약명 + 화이트리스트 미매치 시 throw.
 *
 * 현재는 BUILTIN_CLI_DEFS 의 saveAs 만 호출 경로상 들어오지만, ROADMAP 의
 * CLI def plugin (`~/.multi-account-tool/cli-defs/*.json`) 도입 시 신뢰할 수 없는
 * 입력이 되므로 정의 단계가 아닌 사용 단계 (profile-store) 에서 마지막 방어선을 둔다.
 */
export function validateProfileFileName(rawFileName: string): string {
  if (PROFILE_FILE_NAME_RESERVED.has(rawFileName)) {
    throw new Error('"." 또는 ".." 는 프로필 파일명으로 사용할 수 없습니다.');
  }
  if (/[/\\\x00]/.test(rawFileName)) {
    throw new Error('프로필 파일명에 / \\ NUL 은 포함될 수 없습니다.');
  }
  if (!PROFILE_FILE_NAME_RE.test(rawFileName)) {
    throw new Error('프로필 파일명은 영문/숫자/._- 만 사용 가능하며 1~64자 이내여야 합니다.');
  }
  return rawFileName;
}

/** 특정 CLI 의 프로필 이름 목록 (디렉토리 기반, 알파벳 순). */
export async function listProfiles(cliId: string): Promise<string[]> {
  validateCliId(cliId);
  try {
    const entries = await fs.readdir(cliProfilesDir(cliId), { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** 프로필 존재 여부. */
export async function profileExists(cliId: string, name: string): Promise<boolean> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  try {
    await fs.access(profileDir(cliId, safeName));
    return true;
  } catch {
    return false;
  }
}

async function writeMeta(meta: Profile): Promise<void> {
  await writeFileAtomic(profileMetaPath(meta.cli, meta.name), JSON.stringify(meta, null, 2));
}

/** 프로필 생성 (디렉토리 + meta.json). 이미 존재하면 에러. */
export async function createProfile(
  cliId: string,
  rawName: string,
  label?: string
): Promise<Profile> {
  validateCliId(cliId);
  const name = validateProfileName(rawName);
  if (await profileExists(cliId, name)) {
    throw new Error(`이미 존재하는 프로필입니다: ${name}`);
  }
  await fs.mkdir(profileDir(cliId, name), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const meta: Profile = { name, cli: cliId, createdAt: now, updatedAt: now, label };
  await writeMeta(meta);
  return meta;
}

/** 프로필 meta.json 읽기. 없으면 null. */
export async function readMeta(cliId: string, name: string): Promise<Profile | null> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  try {
    const raw = await fs.readFile(profileMetaPath(cliId, safeName), 'utf8');
    return JSON.parse(raw) as Profile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** updatedAt 만 갱신 (메타가 없으면 no-op). */
export async function touchProfile(cliId: string, name: string): Promise<void> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const meta = await readMeta(cliId, safeName);
  if (!meta) return;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(meta);
}

/**
 * 프로필 이름 변경 (디렉토리 rename + 메타 업데이트).
 * meta 업데이트 실패 시 디렉토리 rename 을 원래대로 롤백 (best-effort).
 */
export async function renameProfile(
  cliId: string,
  oldName: string,
  rawNewName: string
): Promise<void> {
  validateCliId(cliId);
  const safeOld = validateProfileName(oldName);
  const newName = validateProfileName(rawNewName);
  if (safeOld === newName) return;
  if (await profileExists(cliId, newName)) {
    throw new Error(`이미 존재하는 프로필 이름입니다: ${newName}`);
  }
  await fs.rename(profileDir(cliId, safeOld), profileDir(cliId, newName));
  try {
    const meta = await readMeta(cliId, newName);
    if (meta) {
      meta.name = newName;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(meta);
    }
  } catch (err) {
    await fs.rename(profileDir(cliId, newName), profileDir(cliId, safeOld)).catch(() => {
      /* 롤백 실패는 무시 — 원본 에러를 호출자에게 전파 */
    });
    throw err;
  }
}

/** 프로필 삭제 (디렉토리 전체). 존재하지 않아도 에러 없음. */
export async function deleteProfile(cliId: string, name: string): Promise<void> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  await fs.rm(profileDir(cliId, safeName), { recursive: true, force: true });
}

/** 프로필 내 임의 파일 읽기. 없으면 null. */
export async function readProfileFile(
  cliId: string,
  name: string,
  fileName: string
): Promise<string | null> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const safeFile = validateProfileFileName(fileName);
  try {
    return await fs.readFile(profileFilePath(cliId, safeName, safeFile), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * 프로필 내 임의 파일 쓰기 (atomic + 0600 + O_NOFOLLOW).
 * 디렉토리는 필요 시 생성.
 */
export async function writeProfileFile(
  cliId: string,
  name: string,
  fileName: string,
  value: string
): Promise<void> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const safeFile = validateProfileFileName(fileName);
  await fs.mkdir(profileDir(cliId, safeName), { recursive: true, mode: 0o700 });
  await writeFileAtomic(profileFilePath(cliId, safeName, safeFile), value);
}
