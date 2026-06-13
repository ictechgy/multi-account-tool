/**
 * `mat exec <cli> <profile> -- <cmd...>` 의 실행 로직.
 *
 * 흐름:
 *   1. 인자 검증 (cli/profile 유효성, cmd 비어있지 않음, 활성 프로필 존재)
 *   2. 신호 forwarder 를 runExec 진입부에 등록 (swap/spawn/restore 전 구간 보호)
 *   3. cli 별 lock 획득 (동일 cli 의 동시 swap 방지). LockBody 에 execMode='exec' +
 *      previousActive 기록 → 비정상 종료 후 다음 mat 호출의 stale recovery 가 surface
 *      (PR-I*).
 *   4. profile 로 swap (switchProfile 의 안전 시퀀스 사용)
 *   5. 자식 프로세스 spawn (stdio inherit, 셸 미경유) + settled-guard 로 error/exit race 보호
 *   6. spawn 의 성공/실패와 무관하게 swap 했으면:
 *      a) 라이브 재캡처 (snapshotLiveToProfile) — cmd 가 OAuth refresh rotation 으로
 *         자체 토큰을 갱신했다면 새 토큰을 swap-target profile 에 저장 (PR-I*).
 *      b) previousActive 로 restore (switchProfile, skipPreSwapSnapshot=true) — 라이브
 *         재캡처를 이미 했으므로 switchProfile 내부 snapshot 중복 회피.
 *   7. lock release
 *   8. 신호 forwarder 해제, 자식 결과 + restoreError 를 ExecResult 로 반환
 *
 * 신호 처리 (Phase 0 review 의 race 해결):
 *  - SIGINT/SIGTERM/SIGHUP forwarder 는 runExec 진입 직후 ~ 종료 직전까지 활성.
 *    spawn 직전 race, restore 중 두 번째 시그널, lock release 중 시그널 모두 보호.
 *  - 받은 시그널은 받은 채로 기록만 하고 mat 본 프로세스는 즉시 종료하지 않는다 —
 *    finally chain 이 완료된 뒤 cli.tsx 가 동일 시그널을 재발생시켜 부모에게 전파한다.
 *
 * 한계:
 *  - 자식이 시작 시점에 자격증명을 읽어 메모리에 보관하는 경우에만 시간 격리가 유효.
 *  - SIGKILL / SIGSEGV / SIGBUS 는 OS 보장상 trap 불가 — finally 도 signal handler 도
 *    실행되지 않아 라이브 재캡처/restore/lock release 모두 누락. 회복은 다음 mat 호출의
 *    stale lock recovery (정책 B — warn + drop) 에 전적으로 의존한다. 활성 포인터는
 *    swap profile 에 남고, LockBody.previousActive 가 사용자에게 안내된다 (PR-I*).
 */

import { ChildProcess, spawn } from 'node:child_process';

import { findCliDef } from './cli-defs.js';
import { withCliMutationLock } from './cli-mutation-lock.js';
import { getActiveProfile } from './config.js';
import { UsageError, errorMessage } from './errors.js';
import { profileExists, validateProfileName } from './profile-store.js';
import { snapshotLiveToProfile, switchProfile } from './switcher.js';
import { getRecaptureTimeoutMs, withTimeout } from './timeout.js';

export interface ExecOptions {
  cliId: string;
  profileName: string;
  command: string;
  args: string[];
}

export interface ExecResult {
  /** 자식의 종료 코드. signal 종료 시 null. */
  code: number | null;
  /** 자식이 받은 시그널 (있으면). */
  signal: NodeJS.Signals | null;
  /** restore (swap 원복) 실패 시 설정. cli.tsx 가 별도 exit code 로 매핑. */
  restoreError?: Error;
}

/** 외부에서 잡고 자식에게 전달할 시그널 목록. */
const FORWARD_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// 라이브 재캡처 단계(snapshotLiveToProfile)의 타임아웃·withTimeout 은 './timeout.js' 공유 모듈에서
// import 한다 (PR #61 2회차 — session.ts 와의 중복 + 단일 env 가 두 default 를 제어하던 위험 제거).

/**
 * mat exec 메인. 검증 실패는 UsageError throw, 자식 실행 결과는 ExecResult 로 반환.
 * spawn 실패 시 throw — restore 는 throw 전에 best-effort 로 시도된다.
 */
export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const profileName = validateInputs(opts);

  // 신호 forwarder: spawn 전후, restore 중 시그널 모두 흡수해 finally 가 완료되도록.
  // 자식이 존재하면 forward, 아니면 무시. 받은 시그널은 cli.tsx 가 재발생시킨다.
  const childRef: { current: ChildProcess | null } = { current: null };
  const forwarders = registerForwarders(childRef);

  try {
    return await withCliMutationLock(
      {
        cliId: opts.cliId,
        profileName,
        execMode: 'exec',
        affectsCliIds: [opts.cliId],
        prepareMetadata: async () => {
          // profileExists + previousActive 모두 lock 안에서 읽어 foreground mutation 과의
          // TOCTOU 를 차단한다. LockBody.previousActive 도 이 locked read 와 일치한다.
          if (!(await profileExists(opts.cliId, profileName))) {
            throw new UsageError(`프로필을 찾을 수 없습니다: ${opts.cliId}/${profileName}`);
          }
          return { previousActive: await loadPreviousActive(opts.cliId) };
        }
      },
      async ({ body }) => {
        const previousActive = body.previousActive;
        if (!previousActive) {
          throw new Error('exec lock metadata 에 previousActive 가 없습니다');
        }
        return runUnderLock(opts, profileName, previousActive, childRef);
      }
    );
  } finally {
    forwarders.dispose();
  }
}

/** 검증: cli 존재, profile 이름 유효, profile 존재, cmd 비어있지 않음. UsageError. */
function validateInputs(opts: ExecOptions): string {
  if (!findCliDef(opts.cliId)) {
    throw new UsageError(`알 수 없는 CLI: ${opts.cliId}`);
  }
  const profileName = validateProfileName(opts.profileName);
  if (!opts.command) {
    throw new UsageError('실행할 명령이 비어 있습니다. `-- <cmd>` 뒤에 명령을 지정하세요.');
  }
  return profileName;
}

/** 활성 프로필 조회. 미설정이면 UsageError (mat exec 거부). */
async function loadPreviousActive(cliId: string): Promise<string> {
  const active = await getActiveProfile(cliId);
  if (!active) {
    throw new UsageError(
      `mat exec 는 활성 프로필이 설정된 상태에서만 사용할 수 있습니다. ` +
      `먼저 \`mat\` 으로 라이브 자격증명을 프로필로 가져오세요.`
    );
  }
  return active;
}

/** lock 보유 상태에서 profile 확인 → swap → spawn → restore. */
async function runUnderLock(
  opts: ExecOptions,
  profileName: string,
  previousActive: string,
  childRef: { current: ChildProcess | null }
): Promise<ExecResult> {
  // profileExists 를 lock 안에서 한 번 더 확인 — lock 밖 TOCTOU 회피.
  if (!(await profileExists(opts.cliId, profileName))) {
    throw new UsageError(`프로필을 찾을 수 없습니다: ${opts.cliId}/${profileName}`);
  }
  const swapped = previousActive !== profileName;
  if (swapped) {
    await switchProfile(opts.cliId, profileName);
  }

  // spawn 결과/에러를 모두 capture 한 뒤 restore 를 항상 시도하고, 마지막에 결과 합성.
  let spawnResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  let spawnError: unknown;
  try {
    spawnResult = await spawnAndWait(opts.command, opts.args, childRef);
  } catch (err) {
    spawnError = err;
  }

  const restoreError = swapped
    ? await recaptureAndRestoreBestEffort(opts.cliId, profileName, previousActive)
    : undefined;

  if (spawnError) throw spawnError;
  return { code: spawnResult!.code, signal: spawnResult!.signal, restoreError };
}

/** 자식 spawn + 종료 대기. settled flag 로 error/exit 중복 처리 방지. */
function spawnAndWait(
  command: string,
  args: string[],
  childRef: { current: ChildProcess | null }
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    childRef.current = child;

    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      childRef.current = null;
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      action();
    };

    child.on('error', (err) => settle(() => reject(err)));
    child.on('exit', (code, signal) => settle(() => resolve({ code, signal })));
  });
}

/** SIGINT/SIGTERM/SIGHUP 을 자식에게 forward. 자식 없으면 무시. dispose 로 해제. */
function registerForwarders(
  childRef: { current: ChildProcess | null }
): { dispose(): void } {
  const handlers = FORWARD_SIGNALS.map((sig) => {
    const handler = () => {
      const child = childRef.current;
      if (!child) return;
      if (child.exitCode != null || child.signalCode != null) return;
      try {
        child.kill(sig);
      } catch {
        /* best-effort */
      }
    };
    process.on(sig, handler);
    return { sig, handler };
  });
  return {
    dispose() {
      for (const { sig, handler } of handlers) {
        process.removeListener(sig, handler);
      }
    }
  };
}

/**
 * PR-I*: cmd 종료 시점 라이브 재캡처 후 previousActive 로 원복.
 *
 * 동기: `mat exec <cli> <P> -- <cmd>` 의 cmd 가 자체적으로 OAuth refresh rotation 을
 * 수행해 라이브 자격증명을 갱신했을 수 있다. 단순히 previousActive 로 restore 만
 * 하면 그 새 토큰이 옛 토큰으로 덮어써져 손실된다 (provider 가 옛 refresh_token 을
 * 다음 사용 시 revoke → 강제 재로그인).
 *
 * 흐름:
 *  1) snapshotLiveToProfile(cliId, swapTarget) — 라이브 → swap-target 프로필 저장본
 *     덮어쓰기. cmd 가 갱신한 토큰이 있다면 그대로 보존.
 *  2) switchProfile(cliId, previousActive, { skipPreSwapSnapshot: true }) — restore +
 *     setActive. skip 옵션으로 switchProfile 내부 자동 snapshot 중복 회피 (1 에서 이미
 *     했으므로). PR-G 의 폐기 path 와 동일 mechanism 활용.
 *
 * 재캡처 실패는 best-effort — stderr 안내 후 restore 진행. cmd 가 rotation 했다면
 * 새 토큰이 옛 토큰으로 덮어써져 손실될 수 있다는 사용자 인지. restore 실패는 기존
 * 동작 동일 — 활성 포인터가 swap profile 에 남고 호출자가 exit 74 매핑.
 */
async function recaptureAndRestoreBestEffort(
  cliId: string,
  swapTarget: string,
  previousActive: string
): Promise<Error | undefined> {
  await recaptureLiveToTarget(cliId, swapTarget);
  return restoreToActive(cliId, previousActive);
}

/**
 * swap-target profile 로 라이브 재캡처. 실패/타임아웃은 stderr 안내 후 swallow.
 *
 * timeout 도입 (quad-review iter 1 Strong MED): `snapshotLiveToProfile` 가 keychain
 * prompt / NFS stall 등으로 무한 대기하면 finally 전체가 막혀 mat 이 종료되지 않는
 * 문제. {@link getRecaptureTimeoutMs} 으로 bound (호출 시점 env 평가).
 *
 * 사용자 후속 action 안내 (quad-review iter 1 Split LOW): restore 실패 / stale
 * recovery 안내와 일관되게 `mat freshness <cli>` 권장을 stderr 에 명시.
 */
async function recaptureLiveToTarget(cliId: string, swapTarget: string): Promise<void> {
  try {
    await withTimeout(
      snapshotLiveToProfile(cliId, swapTarget),
      getRecaptureTimeoutMs(),
      'recapture(snapshotLiveToProfile)'
    );
  } catch (err) {
    process.stderr.write(
      `\n[mat] swap 프로필(${swapTarget}) 의 라이브 재캡처 실패: ${errorMessage(err)}\n` +
      `[mat] cmd 가 자격증명을 갱신했다면 새 토큰이 손실될 수 있습니다.\n` +
      `[mat] 'mat freshness ${cliId}' 로 라이브 상태를 확인하세요.\n`
    );
  }
}

/** previousActive 로 원복. 성공 시 undefined, 실패 시 stderr 안내 + Error 반환. */
async function restoreToActive(
  cliId: string,
  previousActive: string
): Promise<Error | undefined> {
  try {
    // skipPreSwapSnapshot: recapture 단계에서 이미 라이브를 스냅샷했으므로 중복 회피.
    await switchProfile(cliId, previousActive, { skipPreSwapSnapshot: true });
    return undefined;
  } catch (err) {
    process.stderr.write(
      `\n[mat] 원래 프로필(${previousActive}) 로 원복 실패: ${errorMessage(err)}\n` +
      `[mat] 활성 포인터가 swap 한 프로필에 남아 있을 수 있습니다. \`mat\` 으로 확인하세요.\n`
    );
    return err instanceof Error ? err : new Error(String(err));
  }
}
