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

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, dirname } from 'node:path';

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

/**
 * 종료 재캡처(`mat session`)의 2-phase commit 용 staged write.
 *
 * value 를 최종 프로필 경로 **옆 staging 파일**에 atomic(0600/O_NOFOLLOW)으로 쓰고 그
 * 경로를 반환한다. 라이브 프로필 파일은 {@link commitStagedFile} 호출 전까지 무변경이므로,
 * 여러 cred 를 "전부 stage 성공 → 일괄 commit" 하면 split(절반 새/절반 옛 토큰) 윈도우가
 * byte-write 전체가 아닌 빠른 rename 으로 축소된다. stage 단계에서 hang/실패해도 라이브
 * 프로필은 손상되지 않는다 (PR #61 quad-review Codex H1 — withTimeout 가 hung write 를
 * 취소하지 못해 late-landing 시 split 재발생하던 문제의 구조적 해소).
 *
 * staging 파일은 최종 파일과 같은 디렉토리에 두어 commit rename 이 동일 fs 내(EXDEV 없음)
 * atomic 이 되도록 보장한다.
 */
export async function stageProfileFile(
  cliId: string,
  name: string,
  fileName: string,
  value: string
): Promise<string> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const safeFile = validateProfileFileName(fileName);
  await fs.mkdir(profileDir(cliId, safeName), { recursive: true, mode: 0o700 });
  const finalPath = profileFilePath(cliId, safeName, safeFile);
  const stagingPath = `${finalPath}.recap-${randomBytes(6).toString('hex')}`;
  await writeFileAtomic(stagingPath, value);
  return stagingPath;
}

/** stageProfileFile 이 만드는 staging basename 패턴: `<finalBase>.recap-<hex>`. */
const STAGING_SUFFIX_RE = /^\.recap-[0-9a-f]+$/;

/**
 * {@link stageProfileFile} 산출 staging 파일을 최종 프로필 경로로 atomic rename(commit).
 *
 * stagingPath 의 신원을 검증한다 (PR #61 2회차 Forge MEDIUM — 호출자 규율 의존 hidden coupling
 * 제거): (1) 최종 파일과 같은 디렉토리, (2) basename 이 `<finalBase>.recap-<hex>` 패턴(다른
 * cred 파일/임의 파일을 target 위로 rename 하는 것 차단), (3) 비-symlink. 어긋나면 throw.
 */
export async function commitStagedFile(
  stagingPath: string,
  cliId: string,
  name: string,
  fileName: string
): Promise<void> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const safeFile = validateProfileFileName(fileName);
  const finalPath = profileFilePath(cliId, safeName, safeFile);
  const finalBase = basename(finalPath);
  const stagingBase = basename(stagingPath);
  const suffix = stagingBase.startsWith(finalBase) ? stagingBase.slice(finalBase.length) : null;
  if (dirname(stagingPath) !== dirname(finalPath) || suffix === null || !STAGING_SUFFIX_RE.test(suffix)) {
    throw new Error('staging 경로가 예상 패턴(<file>.recap-<hex>)이 아닙니다 (commit 거부).');
  }
  if ((await fs.lstat(stagingPath)).isSymbolicLink()) {
    throw new Error('staging 이 symlink 입니다 (commit 거부).');
  }
  await fs.rename(stagingPath, finalPath);
}

/** {@link stageProfileFile} staging 파일 best-effort 삭제 (stage 실패/미커밋 롤백). */
export async function discardStagedFile(stagingPath: string): Promise<void> {
  await fs.rm(stagingPath, { force: true }).catch(() => {
    /* best-effort — 롤백 경로의 원본 에러를 가리지 않는다 */
  });
}

/**
 * 프로필 내 단일 파일 삭제 (없어도 에러 없음).
 * 재캡처 롤백에서 "종료 전 존재하지 않던 cred"(backup=null)를 commit 후 원복할 때,
 * 원복 대상이 "파일 부재" 이므로 삭제로 되돌린다 (PR #61 Codex MEDIUM — null-backup 잔여).
 */
export async function removeProfileFile(
  cliId: string,
  name: string,
  fileName: string
): Promise<void> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const safeFile = validateProfileFileName(fileName);
  await fs.rm(profileFilePath(cliId, safeName, safeFile), { force: true });
}
