/**
 * `mat exec` 의 cli 별 직렬화용 lockfile.
 *
 * 동기:
 *  - `mat exec` 는 OS 전역 자격증명을 swap 한다. 동일 cli 에 대해 두 프로세스가
 *    동시에 swap 하면 서로의 라이브 상태를 덮어써 credential 손상이 발생할 수 있다.
 *  - 따라서 cli 별로 한 번에 하나의 mat exec 만 허용한다.
 *
 * 설계 (mkdir-lock + owner token):
 *  - 경로: ~/.multi-account-tool/locks/<cliId>.lock/  (디렉토리)
 *  - 내부: info.json = { pid, startedAt, profile, token }
 *  - POSIX `mkdir(2)` 는 atomic — 이미 존재하면 EEXIST. 두 프로세스가 동시에 mkdir 하면
 *    하나만 성공한다 (file-level O_EXCL 의 두 단계 create+write race 우회).
 *  - stale lock (죽은 pid) 회수는 lock 디렉토리를 unique stale 이름으로 atomic rename
 *    한 뒤에만 rm 한다. 두 회수자가 동시에 시도하면 rename 이 하나만 성공해 race 없음.
 *  - release 는 info.json 의 token 이 우리 것과 일치할 때만 수행 (다른 holder 의 lock
 *    실수 삭제 방지).
 *
 * 한계:
 *  - NFS / 일부 네트워크 파일시스템은 mkdir atomicity 미보장. macOS / Linux 로컬 fs 전용.
 *  - SIGKILL 등으로 mat 자체가 강제 종료되면 lock 잔존 → 다음 호출의 stale recovery 가 정리.
 *  - PID 재사용 윈도우: 죽은 PID 가 다른 long-lived 프로세스에 재할당된 경우 LockHeldError
 *    가 계속 발생. 사용자가 수동으로 lock 디렉토리 제거 가능.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { writeFileAtomic } from './io-atomic.js';
import { cliLockPath } from './paths.js';

const INFO_FILENAME = 'info.json';

/** 빈/손상 info.json 이 live holder 의 in-flight write 인지 확인하기 위해 짧게 대기. */
const INFLIGHT_WRITE_WAIT_MS = 200;

interface LockBody {
  pid: number;
  startedAt: string;
  profile: string;
  /** 우리 인스턴스를 식별하는 무작위 토큰 (release 시 ownership 검증용). */
  token: string;
}

/** lock 이 이미 살아있는 다른 프로세스에 의해 점유 중일 때 throw. */
export class LockHeldError extends Error {
  readonly exitCode = 75;
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
 * stale lock (죽은 pid 또는 손상된 info) 은 atomic rename 후 한 번 정리하고 재시도.
 */
export async function acquireCliLock(
  cliId: string,
  profileName: string
): Promise<() => Promise<void>> {
  const lockDir = cliLockPath(cliId);
  await fs.mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });

  const body: LockBody = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    profile: profileName,
    token: randomBytes(16).toString('hex')
  };

  // 최대 2회 시도: 1회차 conflict → stale 회수 후 2회차에서 mkdir 재시도.
  for (let attempt = 0; attempt < 2; attempt++) {
    const acquired = await tryAcquire(lockDir, body);
    if (acquired) return () => releaseIfOwned(lockDir, body.token);
    await handleConflict(lockDir, cliId);
  }

  // 2회 모두 실패 — 마지막으로 보인 holder 정보를 가능한 한 정확히 보고.
  const holder = await readInfo(lockDir);
  if (holder) throw new LockHeldError(cliId, holder);
  throw new Error(`lock 획득 실패 (${cliId}): 반복된 race`);
}

/** mkdir → writeFileAtomic 으로 lock 시도. 성공 시 true. EEXIST 시 false. 그 외 throw. */
async function tryAcquire(lockDir: string, body: LockBody): Promise<boolean> {
  try {
    await fs.mkdir(lockDir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
  // 디렉토리는 우리 것. info.json 을 atomic 으로 쓴다.
  try {
    await writeFileAtomic(join(lockDir, INFO_FILENAME), JSON.stringify(body));
    return true;
  } catch (err) {
    // info 쓰기 실패 → 자기 lock 디렉토리 정리 (다른 프로세스가 빈 dir 을 stale 로 오인하지 않도록).
    await fs.rm(lockDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    throw err;
  }
}

/** EEXIST 발생 시 호출: holder 가 죽었으면 atomic rename 후 정리. live holder 면 throw. */
async function handleConflict(lockDir: string, cliId: string): Promise<void> {
  // 짧게 대기 — 다른 프로세스가 막 mkdir 성공하고 info.json write 중인 윈도우 보호.
  await delay(INFLIGHT_WRITE_WAIT_MS);
  const info = await readInfo(lockDir);
  if (info && isProcessAlive(info.pid)) {
    throw new LockHeldError(cliId, info);
  }
  // info 없음 (corrupt) 또는 pid 죽음 → stale 로 판정.
  // 회수자 race 방지: 디렉토리를 unique stale 이름으로 atomic rename 시도.
  // 한 회수자만 rename 성공한다.
  const staleSuffix = randomBytes(8).toString('hex');
  const stalePath = `${lockDir}.stale-${staleSuffix}`;
  try {
    await fs.rename(lockDir, stalePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return; // 다른 회수자가 이미 처리. mkdir 재시도.
    if (code === 'ENOTEMPTY' || code === 'EEXIST') return; // rare on POSIX; 양보.
    throw err;
  }
  // rename 성공 → 우리가 회수 권한 보유. 안전하게 삭제.
  await fs.rm(stalePath, { recursive: true, force: true }).catch(() => { /* best-effort */ });
}

/** info.json 읽기. 없거나 손상되면 null. */
async function readInfo(lockDir: string): Promise<LockBody | null> {
  try {
    const raw = await fs.readFile(join(lockDir, INFO_FILENAME), 'utf8');
    const parsed = JSON.parse(raw) as Partial<LockBody>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.token !== 'string'
    ) return null;
    return {
      pid: parsed.pid,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      profile: typeof parsed.profile === 'string' ? parsed.profile : '',
      token: parsed.token
    };
  } catch {
    return null;
  }
}

/** PID 가 살아있는지 검사. EPERM 은 살아있는 것으로 보수적 처리. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** info.json 의 token 이 우리 것과 일치할 때만 lock 디렉토리 삭제. */
async function releaseIfOwned(lockDir: string, myToken: string): Promise<void> {
  const info = await readInfo(lockDir);
  if (!info || info.token !== myToken) return;
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => { /* best-effort */ });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
