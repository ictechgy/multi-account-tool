/**
 * 프로필 CRUD: 디스크 디렉토리/메타 파일 관리.
 * 자격증명 데이터 자체는 source 별 saveAs 파일에 저장되며,
 * 본 모듈은 read/write 헬퍼만 제공한다 (값의 해석은 source 모듈이 담당).
 *
 * 모든 파일 쓰기는 io-atomic 의 writeFileAtomic (O_EXCL + O_NOFOLLOW + 0600) 으로 통일.
 *
 * 모든 public 함수는 path traversal 방어를 위해 입력값을 진입 즉시 검증한다:
 *  - cliId  → validateCliId      (paths.ts 정의; 영문 시작 + 영숫자/`_`/`-` 1~32자)
 *  - name   → validateProfileName (paths.ts 정의; NFC 정규화 + 예약명/구분자 차단 + 1~40자)
 *  - 파일명 → validateProfileFileName (paths.ts 정의; 영숫자/`.`/`_`/`-` 1~64자)
 *
 * 검증된 NFC-정규화 결과를 path 구성에 사용해, 입력이 NFD/raw 였더라도
 * 디스크에는 단일 NFC 표기로 통일된다. paths.ts 의 path constructor 들도
 * 동일 검증을 수행하므로 외부 직접 호출자도 우회 불가 (defense-in-depth).
 */

import { promises as fs } from 'node:fs';
import { writeFileAtomic } from './io-atomic.js';
import {
  cliProfilesDir,
  profileDir,
  profileFilePath,
  profileMetaPath,
  validateCliId,
  validateProfileFileName,
  validateProfileName
} from './paths.js';
import type { Profile } from './types.js';

// app.tsx / exec.ts 등 외부 호출자 backward compat 용 re-export.
// 검증자는 paths.ts 단일 소스 — profile-store.ts 에 별도 정의 없음.
export { validateProfileFileName, validateProfileName } from './paths.js';

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

/**
 * 프로필 생성 (디렉토리 + meta.json). 이미 존재하면 에러.
 * writeMeta 실패 (디스크 풀/권한 거부 등) 시 생성된 디렉토리를 best-effort 롤백 —
 * renameProfile 의 catch 분기와 동일한 패턴으로 부분 상태 (디렉토리만 남고 meta 없음) 방지.
 */
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
  try {
    await writeMeta(meta);
  } catch (err) {
    await fs.rm(profileDir(cliId, name), { recursive: true, force: true }).catch(() => {
      /* 롤백 실패는 무시 — 원본 에러를 호출자에게 전파 */
    });
    throw err;
  }
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
  const safeNew = validateProfileName(rawNewName);
  if (safeOld === safeNew) return;
  if (await profileExists(cliId, safeNew)) {
    throw new Error(`이미 존재하는 프로필 이름입니다: ${safeNew}`);
  }
  await fs.rename(profileDir(cliId, safeOld), profileDir(cliId, safeNew));
  try {
    const meta = await readMeta(cliId, safeNew);
    if (meta) {
      meta.name = safeNew;
      meta.updatedAt = new Date().toISOString();
      await writeMeta(meta);
    }
  } catch (err) {
    await fs.rename(profileDir(cliId, safeNew), profileDir(cliId, safeOld)).catch(() => {
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
