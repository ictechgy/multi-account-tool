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
import { constants, promises as realFs } from 'node:fs';
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
import type { ProfileIdentitySummary } from './types.js';

// app.tsx / exec.ts 등 외부 호출자 backward compat 용 re-export.
// 검증자는 paths.ts 단일 소스 — profile-store.ts 에 별도 정의 없음.
export { validateProfileFileName, validateProfileName } from './paths.js';

type ProfileStoreFsOps = typeof realFs;
let fs: ProfileStoreFsOps = realFs;

/** Deterministic profile-transaction fault injection seam. Tests must restore with `null`. */
export function __setProfileStoreFsOpsForTests(overrides: Partial<ProfileStoreFsOps> | null): void {
  fs = overrides ? Object.assign(Object.create(realFs) as ProfileStoreFsOps, overrides) : realFs;
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

/** Internal transaction helper: preserve meta.json byte-for-byte on rollback. */
export async function readProfileMetaRaw(cliId: string, name: string): Promise<string | null> {
  try { return await fs.readFile(profileMetaPath(validateCliId(cliId), validateProfileName(name)), 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
}

/** Internal transaction helper; callers must already hold the CLI mutation lock. */
export async function writeProfileMetaRaw(cliId: string, name: string, value: string): Promise<void> {
  await writeFileAtomic(profileMetaPath(validateCliId(cliId), validateProfileName(name)), value);
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

/** capture/recapture 성공 후 updatedAt + sanitized identity metadata 를 함께 기록. */
export async function recordProfileCapture(
  cliId: string,
  name: string,
  identity: ProfileIdentitySummary
): Promise<void> {
  validateCliId(cliId);
  const safeName = validateProfileName(name);
  const meta = await readMeta(cliId, safeName);
  if (!meta) return;
  meta.updatedAt = identity.capturedAt;
  meta.identity = identity;
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
  const lst = await fs.lstat(stagingPath);
  if (lst.isSymbolicLink() || !lst.isFile()) {
    throw new Error('staging 이 일반 파일이 아닙니다 (symlink/디렉토리 등 — commit 거부).');
  }
  await fs.rename(stagingPath, finalPath);
}

interface CaptureTransactionEntry {
  fileName: string;
  stagingPath: string;
  backupPath: string;
  existed: boolean;
}
interface CaptureTransaction { version: 1; phase: 'applying' | 'committed'; entries: CaptureTransactionEntry[]; }
const CAPTURE_BACKUP_SUFFIX = /^\.mat-capture-backup-[0-9a-f]{12}$/;

function captureMarkerPath(cliId: string, name: string): string {
  return `${profileDir(validateCliId(cliId), validateProfileName(name))}/.mat-capture-txn.json`;
}
async function syncProfileDirectory(cliId: string, name: string): Promise<void> {
  const directory = profileDir(validateCliId(cliId), validateProfileName(name));
  const before = await fs.lstat(directory);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('unsafe profile capture directory');
  const fd = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await fd.sync(); } finally { await fd.close(); }
  const after = await fs.lstat(directory);
  if (after.isSymbolicLink() || !after.isDirectory() || after.dev !== before.dev || after.ino !== before.ino) throw new Error('profile capture directory identity changed');
}

/**
 * Recover an interrupted profile capture by restoring the complete old set,
 * including meta.json.  A marker is deliberately retained if a candidate is
 * ambiguous or a compensating operation fails; callers must not continue into
 * a partial capture.
 */
export async function recoverProfileCaptureTransaction(cliId: string, name: string): Promise<void> {
  const markerPath = captureMarkerPath(cliId, name);
  let marker: CaptureTransaction;
  try { marker = JSON.parse(await fs.readFile(markerPath, 'utf8')) as CaptureTransaction; }
  catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; throw err; }
  if (marker.version !== 1 || !['applying', 'committed'].includes(marker.phase) || !Array.isArray(marker.entries)) throw new Error('invalid profile capture transaction marker');
  try {
    for (const item of [...marker.entries].reverse()) {
      const fileName = validateProfileFileName(item.fileName);
      const target = profileFilePath(cliId, name, fileName);
      const finalBase = basename(target);
      const stageSuffix = basename(item.stagingPath).startsWith(finalBase) ? basename(item.stagingPath).slice(finalBase.length) : '';
      const backupSuffix = basename(item.backupPath).startsWith(finalBase) ? basename(item.backupPath).slice(finalBase.length) : '';
      if (dirname(item.stagingPath) !== dirname(target) || dirname(item.backupPath) !== dirname(target) || !STAGING_SUFFIX_RE.test(stageSuffix) || !CAPTURE_BACKUP_SUFFIX.test(backupSuffix)) throw new Error('invalid profile capture transaction path');
      const backup = await fs.lstat(item.backupPath).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
      const targetSt = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
      const stage = await fs.lstat(item.stagingPath).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
      if (marker.phase === 'committed') {
        if (!targetSt || !targetSt.isFile() || targetSt.isSymbolicLink() || stage) throw new Error('invalid committed profile capture state');
        if (backup) {
          if (!item.existed || !backup.isFile() || backup.isSymbolicLink()) throw new Error('unsafe committed profile capture backup');
          await fs.unlink(item.backupPath); await syncProfileDirectory(cliId, name);
        }
        continue;
      }
      if (backup) {
        if (!backup.isFile() || backup.isSymbolicLink()) throw new Error('unsafe profile capture backup');
        if (targetSt) { await fs.unlink(target); await syncProfileDirectory(cliId, name); }
        await fs.rename(item.backupPath, target);
        await syncProfileDirectory(cliId, name);
      } else if (!item.existed && targetSt) {
        if (!targetSt.isFile() || targetSt.isSymbolicLink()) throw new Error('unsafe profile capture target');
        await fs.unlink(target); await syncProfileDirectory(cliId, name);
      } else if (item.existed && !stage) throw new Error('missing profile capture backup');
      if (stage) { if (!stage.isFile() || stage.isSymbolicLink()) throw new Error('unsafe profile capture staging'); await fs.unlink(item.stagingPath); await syncProfileDirectory(cliId, name); }
    }
    await fs.unlink(markerPath);
    await syncProfileDirectory(cliId, name);
  } catch (err) {
    const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? ` (${err.code})` : '';
    throw new Error(`profile capture recovery failed${code}`);
  }
}

/**
 * Commit every staged artifact and meta.json under one durable abort marker.
 * Any interrupted boundary recovers byte-identically to the prior profile;
 * errors include compensating failures instead of silently leaving a split set.
 */
export async function commitProfileCaptureTransaction(
  cliId: string,
  name: string,
  staged: Array<{ fileName: string; stagingPath: string }>
): Promise<void> {
  await recoverProfileCaptureTransaction(cliId, name);
  const entries: CaptureTransactionEntry[] = [];
  for (const item of staged) {
    const fileName = validateProfileFileName(item.fileName);
    const target = profileFilePath(cliId, name, fileName);
    const stageBase = basename(item.stagingPath);
    const stageSuffix = stageBase.startsWith(basename(target)) ? stageBase.slice(basename(target).length) : '';
    if (dirname(item.stagingPath) !== dirname(target) || !STAGING_SUFFIX_RE.test(stageSuffix)) throw new Error('invalid profile capture staging path');
    const stagedSt = await fs.lstat(item.stagingPath);
    if (!stagedSt.isFile() || stagedSt.isSymbolicLink()) throw new Error('unsafe profile capture staging');
    const targetSt = await fs.lstat(target).catch((err: NodeJS.ErrnoException) => err.code === 'ENOENT' ? null : Promise.reject(err));
    if (targetSt && (!targetSt.isFile() || targetSt.isSymbolicLink())) throw new Error('unsafe profile capture target');
    entries.push({ fileName, stagingPath: item.stagingPath, backupPath: `${target}.mat-capture-backup-${randomBytes(6).toString('hex')}`, existed: targetSt != null });
  }
  const markerPath = captureMarkerPath(cliId, name);
  const marker: CaptureTransaction = { version: 1, phase: 'applying', entries };
  await writeFileAtomic(markerPath, JSON.stringify(marker), { mode: 0o600 });
  await syncProfileDirectory(cliId, name);
  let committed = false;
  try {
    for (const item of entries) {
      const target = profileFilePath(cliId, name, item.fileName);
      if (item.existed) { await fs.rename(target, item.backupPath); await syncProfileDirectory(cliId, name); }
      await fs.rename(item.stagingPath, target);
      await syncProfileDirectory(cliId, name);
    }
    marker.phase = 'committed';
    await writeFileAtomic(markerPath, JSON.stringify(marker), { mode: 0o600 });
    await syncProfileDirectory(cliId, name);
    committed = true;
    for (const item of entries) if (item.existed) { await fs.unlink(item.backupPath); await syncProfileDirectory(cliId, name); }
    await fs.unlink(markerPath);
    await syncProfileDirectory(cliId, name);
  } catch (err) {
    try { await recoverProfileCaptureTransaction(cliId, name); }
    catch { throw new Error(committed ? 'profile capture cleanup failed; recovery also failed' : 'profile capture commit failed; rollback also failed'); }
    if (committed) return;
    const code = typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string' ? err.code : undefined;
    const safe = new Error(`profile capture commit failed${code ? ` (${code})` : ''}`) as Error & { code?: string };
    if (code) safe.code = code;
    throw safe;
  }
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
