/**
 * `mat exec` 의 cli 별 직렬화용 lockfile.
 *
 * 동기:
 *  - `mat exec` 는 OS 전역 자격증명을 swap 한다. 동일 cli 에 대해 두 프로세스가
 *    동시에 swap 하면 서로의 라이브 상태를 덮어써 credential 손상이 발생할 수 있다.
 *  - 따라서 cli 별로 한 번에 하나의 mat exec 만 허용한다.
 *
 * 설계:
 *  - 경로: ~/.multi-account-tool/locks/<cliId>.lock
 *  - O_EXCL + O_NOFOLLOW + 0600 으로 atomic 생성 (writeFileAtomic 과 동일 보안 모델)
 *  - 내용: { pid, startedAt, profile } — 디버깅/사용자 안내용
 *  - stale lock 처리: 기존 lock 의 pid 가 죽었으면 (process.kill(pid, 0) ENOENT/ESRCH)
 *    잔존물로 간주, 강제 제거 후 재시도. 살아있으면 즉시 LockHeldError.
 *  - release 는 best-effort. 우리 pid 와 일치할 때만 삭제 (다른 프로세스가 stale recovery 로
 *    재획득한 lock 을 우리가 지우는 것을 방지).
 */

import { constants, promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { cliLockPath } from './paths.js';

const LOCK_FLAGS =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

interface LockBody {
  pid: number;
  startedAt: string;
  profile: string;
}

/** lock 이 이미 살아있는 다른 프로세스에 의해 점유 중일 때 throw. */
export class LockHeldError extends Error {
  constructor(public readonly cliId: string, public readonly holder: LockBody) {
    super(
      `다른 mat exec 가 이 CLI 의 lock 을 보유 중입니다 ` +
      `(cli=${cliId}, pid=${holder.pid}, profile=${holder.profile}, since=${holder.startedAt}).`
    );
    this.name = 'LockHeldError';
  }
}

/**
 * cli 별 lock 을 획득. 성공 시 release 핸들을 반환.
 * 다른 살아있는 프로세스가 점유 중이면 LockHeldError throw.
 * stale lock (죽은 pid) 은 한 번 정리 후 재시도한다.
 */
export async function acquireCliLock(
  cliId: string,
  profileName: string
): Promise<() => Promise<void>> {
  const path = cliLockPath(cliId);
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const myPid = process.pid;
  const body: LockBody = {
    pid: myPid,
    startedAt: new Date().toISOString(),
    profile: profileName
  };
  const payload = JSON.stringify(body);

  try {
    await createLockFile(path, payload);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const reclaimed = await tryReclaimStale(path, payload, cliId);
    if (!reclaimed) {
      // reclaim 이 실패 사유를 throw 했어야 함. 도달 시 방어적 throw.
      throw new Error(`lock 획득 실패: ${cliId}`);
    }
  }

  return () => releaseIfOwned(path, myPid);
}

async function createLockFile(path: string, payload: string): Promise<void> {
  const handle = await fs.open(path, LOCK_FLAGS, 0o600);
  try {
    await handle.writeFile(payload);
  } finally {
    await handle.close().catch(() => { /* best-effort */ });
  }
}

/** EEXIST 시 호출: 기존 lock 의 pid 가 죽었으면 정리 후 재생성 시도. 성공 시 true. */
async function tryReclaimStale(
  path: string,
  payload: string,
  cliId: string
): Promise<boolean> {
  const holder = await readLockBody(path);
  if (holder && isProcessAlive(holder.pid)) {
    throw new LockHeldError(cliId, holder);
  }
  // holder 가 null (corrupt/지워짐) 이거나 pid 가 죽은 상태.
  await fs.rm(path, { force: true }).catch(() => { /* best-effort */ });
  // 재시도. 이번에도 EEXIST 면 다른 프로세스가 동시에 잡은 것.
  try {
    await createLockFile(path, payload);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const racer = await readLockBody(path);
      if (racer) throw new LockHeldError(cliId, racer);
    }
    throw err;
  }
}

async function readLockBody(path: string): Promise<LockBody | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockBody>;
    if (typeof parsed.pid !== 'number') return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      profile: typeof parsed.profile === 'string' ? parsed.profile : ''
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM = 살아있지만 우리가 신호 보낼 권한이 없음 → 살아있는 것으로 간주 (보수적).
    if (code === 'EPERM') return true;
    return false;
  }
}

/** lock 의 pid 가 우리 pid 와 일치할 때만 제거. */
async function releaseIfOwned(path: string, myPid: number): Promise<void> {
  const body = await readLockBody(path);
  if (!body || body.pid !== myPid) return;
  await fs.rm(path, { force: true }).catch(() => { /* best-effort */ });
}
