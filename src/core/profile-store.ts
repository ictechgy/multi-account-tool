/**
 * 프로필 CRUD: 디스크 디렉토리/메타 파일 관리.
 * 자격증명 데이터 자체는 source 별 saveAs 파일에 저장되며,
 * 본 모듈은 read/write 헬퍼만 제공한다 (값의 해석은 source 모듈이 담당).
 */

import { promises as fs } from 'node:fs';
import {
  cliProfilesDir,
  profileDir,
  profileFilePath,
  profileMetaPath
} from './paths.js';
import type { Profile } from './types.js';

/** 프로필 이름 검증 규칙: 한글/영문/숫자/_-. 만 허용, 1~40자. */
const PROFILE_NAME_RE = /^[a-zA-Z0-9가-힣_.-]{1,40}$/;

function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error('프로필 이름은 한글/영문/숫자/_-. 만 사용 가능하며 1~40자 이내여야 합니다.');
  }
}

/** 특정 CLI 의 프로필 이름 목록 (디렉토리 기반, 알파벳 순). */
export async function listProfiles(cliId: string): Promise<string[]> {
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
  try {
    await fs.access(profileDir(cliId, name));
    return true;
  } catch {
    return false;
  }
}

async function writeMeta(meta: Profile): Promise<void> {
  const p = profileMetaPath(meta.cli, meta.name);
  await fs.writeFile(p, JSON.stringify(meta, null, 2), { mode: 0o600 });
}

/** 프로필 생성 (디렉토리 + meta.json). 이미 존재하면 에러. */
export async function createProfile(cliId: string, name: string, label?: string): Promise<Profile> {
  validateProfileName(name);
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
  try {
    const raw = await fs.readFile(profileMetaPath(cliId, name), 'utf8');
    return JSON.parse(raw) as Profile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** updatedAt 만 갱신 (메타가 없으면 no-op). */
export async function touchProfile(cliId: string, name: string): Promise<void> {
  const meta = await readMeta(cliId, name);
  if (!meta) return;
  meta.updatedAt = new Date().toISOString();
  await writeMeta(meta);
}

/** 프로필 이름 변경 (디렉토리 rename + 메타 업데이트). */
export async function renameProfile(cliId: string, oldName: string, newName: string): Promise<void> {
  validateProfileName(newName);
  if (oldName === newName) return;
  if (await profileExists(cliId, newName)) {
    throw new Error(`이미 존재하는 프로필 이름입니다: ${newName}`);
  }
  await fs.rename(profileDir(cliId, oldName), profileDir(cliId, newName));
  const meta = await readMeta(cliId, newName);
  if (meta) {
    meta.name = newName;
    meta.updatedAt = new Date().toISOString();
    await writeMeta(meta);
  }
}

/** 프로필 삭제 (디렉토리 전체). 존재하지 않아도 에러 없음. */
export async function deleteProfile(cliId: string, name: string): Promise<void> {
  await fs.rm(profileDir(cliId, name), { recursive: true, force: true });
}

/** 프로필 내 임의 파일 읽기. 없으면 null. */
export async function readProfileFile(
  cliId: string,
  name: string,
  fileName: string
): Promise<string | null> {
  try {
    return await fs.readFile(profileFilePath(cliId, name, fileName), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 프로필 내 임의 파일 쓰기 (0600). 디렉토리는 필요 시 생성. */
export async function writeProfileFile(
  cliId: string,
  name: string,
  fileName: string,
  value: string
): Promise<void> {
  await fs.mkdir(profileDir(cliId, name), { recursive: true, mode: 0o700 });
  const p = profileFilePath(cliId, name, fileName);
  await fs.writeFile(p, value, { mode: 0o600 });
}
