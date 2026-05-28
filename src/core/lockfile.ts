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

/**
 * lock 이 어떤 mat 호출 흐름에 의해 보유 중인지.
 * - `exec`: `mat exec <cli> <profile> -- <cmd>` 의 자식 lifecycle 동안 보유.
 *   비정상 종료 시 다음 mat 호출의 stale recovery 가 LockBody.previousActive
 *   를 surface 해 사용자가 라이브 상태를 인지하도록 안내한다.
 * - `foreground`: 향후 TUI / 대화형 작업이 직접 이 lock 을 잡을 수 있도록 예약된
 *   값. 현 시점 호출자는 없음 (PR-I* 도입 시점, exec only).
 */
export type LockExecMode = 'foreground' | 'exec';

/**
 * lock 보유 정보. 디스크 (info.json) 와 동일 shape 으로 직렬화된다.
 *
 * `execMode` / `previousActive` / `affectsCliIds` 는 PR-I* 도입 신규 필드 —
 * 옛 mat 으로 생성된 info.json 은 본 필드들이 없으므로 readInfo 가 모두 optional
 * 로 처리한다. stale recovery 경로 (handleConflict) 가 이 부재를 명시 분기해
 * 사용자에게 "옛 버전 lock" 임을 안내 (정책 B — warn + drop).
 */
interface LockBody {
  pid: number;
  startedAt: string;
  profile: string;
  /** 우리 인스턴스를 식별하는 무작위 토큰 (release 시 ownership 검증용). */
  token: string;
  /** lock 보유 흐름의 종류. 옛 lock 은 undefined → "옛 버전" 으로 분류. */
  execMode?: LockExecMode;
  /**
   * lock 획득 직전의 활성 프로필 이름. mat exec 가 swap 했다가 비정상 종료한 뒤
   * 다음 mat 호출의 stale recovery 가 "라이브 = ${profile}, 의도된 활성 =
   * ${previousActive} 일 수 있음" 으로 안내하기 위해 보존.
   */
  previousActive?: string;
  /**
   * 본 lock 이 영향을 주는 cliId 목록 (현재는 단일 [cliId] 만 사용). 향후 OAuth
   * provider 공유 등으로 cross-cli scope 가 필요할 때 schema 만 예약 (plan
   * Scenario 6). 현 시점 stale recovery 는 단일 cliId 가정.
   */
  affectsCliIds?: string[];
}

/**
 * `acquireCliLock` 의 신규 옵션.
 *
 * mat exec finally 가 라이브 재캡처 후 원복하기 위해 LockBody 에 흔적을 남긴다.
 * 옛 호출자는 옵션 미지정 시 default `execMode: 'exec'`, `previousActive`
 * undefined 로 동작 — 기존 LockBody schema 와 호환.
 */
export interface AcquireLockOptions {
  /** 기본 'exec' (현 호출자 모두 mat exec). 향후 TUI 가 'foreground' 로 호출 예정. */
  execMode?: LockExecMode;
  /** lock 획득 직전의 활성 프로필. 비정상 종료 후 stale recovery 안내에 사용. */
  previousActive?: string;
  /** 본 lock 의 영향을 받는 cliId 목록 (현재는 단일 [cliId] — 추후 cross-cli 확장 예약). */
  affectsCliIds?: string[];
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
 * stale lock (죽은 pid 또는 손상된 info) 은 atomic rename 후 한 번 정리하고 재시도 —
 * 회수 직전 LockBody.previousActive 가 있으면 stderr 로 안내 (정책 B — warn + drop).
 */
export async function acquireCliLock(
  cliId: string,
  profileName: string,
  options?: AcquireLockOptions
): Promise<() => Promise<void>> {
  const lockDir = cliLockPath(cliId);
  await fs.mkdir(dirname(lockDir), { recursive: true, mode: 0o700 });

  const body = makeLockBody(cliId, profileName, options);

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

/** acquireCliLock 호출 옵션 + process state 를 LockBody 로 합성. */
function makeLockBody(
  cliId: string,
  profileName: string,
  options: AcquireLockOptions | undefined
): LockBody {
  return {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    profile: profileName,
    token: randomBytes(16).toString('hex'),
    execMode: options?.execMode ?? 'exec',
    previousActive: options?.previousActive,
    affectsCliIds: options?.affectsCliIds ?? [cliId]
  };
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
  // info 가 있고 pid 가 죽음 → 비정상 종료 흔적. 정책 B (warn + drop) — 사용자에게
  // 라이브 자격증명 상태가 의도와 다를 수 있음을 surface 후 lock 회수.
  if (info) warnStaleLockRecovery(cliId, info);

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

/**
 * stale lock 회수 시 사용자에게 라이브 자격증명 상태 안내 (정책 B — warn + drop).
 *
 * 분기 (quad-review iter 1 Strong MED — execMode 기반 정밀화):
 * - `execMode='exec'` + `previousActive` 보유 → 신규 mat exec 의 비정상 종료. 안내문에
 *   "라이브 = swap-target / 의도된 활성 = previousActive" surface.
 * - `execMode='exec'` + `previousActive` 부재 → 신규 exec lock 의 손상 (필드 누락 또는
 *   readInfo normalize 결과). 활성 정보 없이 swap-target 만 안내.
 * - `execMode='foreground'` → 향후 TUI 가 잡은 lock 의 비정상 종료. 현재 호출자 없음
 *   이지만 schema 명시상 분기 (forward-compat).
 * - `execMode` 부재 (옛 mat 버전) → 모든 신규 필드 부재. 일반 안내.
 *
 * stderr 출력 전 모든 lock-derived string 은 {@link sanitizeForStderr} 로 control char
 * strip + length cap (quad-review iter 1 Strong LOW security — terminal escape injection
 * 방어). trust boundary 가 self 라 LOW 지만 defense in depth.
 */
function warnStaleLockRecovery(cliId: string, info: LockBody): void {
  const safeCli = sanitizeForStderr(cliId);
  const swappedTo = sanitizeForStderr(info.profile || '<unknown>');
  const startedAt = sanitizeForStderr(info.startedAt || '<unknown>');

  if (info.execMode === 'exec' && info.previousActive) {
    const safePrev = sanitizeForStderr(info.previousActive);
    process.stderr.write(
      `[mat] 이전 mat exec 가 비정상 종료된 흔적을 발견했습니다 ` +
      `(cli=${safeCli}, pid=${info.pid}, since=${startedAt}).\n` +
      `[mat] 라이브 자격증명이 활성 프로필 '${safePrev}' 이 아닌 ` +
      `'${swappedTo}' 의 것일 수 있습니다.\n` +
      `[mat] 'mat freshness ${safeCli}' 또는 mat TUI 로 상태를 확인하세요.\n`
    );
    return;
  }
  if (info.execMode === 'exec') {
    process.stderr.write(
      `[mat] mat exec lock 의 손상된 흔적을 발견했습니다 ` +
      `(cli=${safeCli}, pid=${info.pid}, profile=${swappedTo}).\n` +
      `[mat] 활성 정보가 누락되어 라이브 자격증명이 의도된 활성 프로필과 다를 수 있습니다.\n` +
      `[mat] 'mat freshness ${safeCli}' 또는 mat TUI 로 확인하세요.\n`
    );
    return;
  }
  if (info.execMode === 'foreground') {
    process.stderr.write(
      `[mat] 이전 mat TUI/foreground 작업의 비정상 종료 흔적을 발견했습니다 ` +
      `(cli=${safeCli}, pid=${info.pid}, profile=${swappedTo}).\n` +
      `[mat] 'mat freshness ${safeCli}' 또는 mat TUI 로 확인하세요.\n`
    );
    return;
  }
  process.stderr.write(
    `[mat] 이전 mat 버전의 exec lock 을 발견했습니다 ` +
    `(cli=${safeCli}, pid=${info.pid}, profile=${swappedTo}).\n` +
    `[mat] 라이브 자격증명이 의도된 활성 프로필과 다를 수 있습니다. ` +
    `'mat freshness ${safeCli}' 또는 mat TUI 로 확인하세요.\n`
  );
}

/**
 * stderr 출력 전 untrusted lock-derived string 의 control char strip + length cap.
 *
 * info.json 은 lock 디렉토리 (`~/.multi-account-tool/locks/`, mode 0o700) 의 사용자
 * 본인이 작성한 파일이지만, 외부 도구가 손상시켰거나 잘못 편집된 경우 ANSI escape
 * sequence / 매우 긴 문자열을 포함할 수 있다. terminal escape injection 방어 — trust
 * boundary 가 self 라 위험도 LOW 지만 defense in depth (quad-review iter 1 Strong
 * LOW security, Codex-2 + Claude-2 합의).
 *
 * 200자 cap 은 안내 메시지 1행 길이와 일치 — 정상 입력 (cliId ≤ 32 / profileName
 * ≤ 40 / ISO timestamp 등) 은 모두 무손실 통과.
 */
function sanitizeForStderr(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?').slice(0, 200);
}

/** info.json 읽기. 없거나 손상되면 null. 신규 optional 필드는 type guard 후 보존. */
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
      token: parsed.token,
      execMode: pickExecMode(parsed.execMode),
      previousActive:
        typeof parsed.previousActive === 'string' ? parsed.previousActive : undefined,
      affectsCliIds: pickStringArray(parsed.affectsCliIds)
    };
  } catch {
    return null;
  }
}

/** execMode 검증 — 'foreground' / 'exec' 외 값은 undefined (옛 lock 또는 손상). */
function pickExecMode(value: unknown): LockExecMode | undefined {
  return value === 'foreground' || value === 'exec' ? value : undefined;
}

/** 문자열 배열만 통과. 비-배열 / 비-문자열 원소 포함 시 undefined (손상으로 간주). */
function pickStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((v) => typeof v === 'string') ? (value as string[]) : undefined;
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
