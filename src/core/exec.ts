/**
 * `mat exec <cli> <profile> -- <cmd...>` 의 실행 로직.
 *
 * 흐름:
 *   1. 인자 검증 (cli/profile 유효성, cmd 비어있지 않음)
 *   2. cli 별 lock 획득 (동일 cli 의 동시 swap 방지)
 *   3. 현재 활성 프로필 기억 (previousActive)
 *   4. profile 로 swap (switchProfile 의 안전 시퀀스 사용)
 *   5. 자식 프로세스 spawn (stdio inherit, 셸 미경유)
 *   6. SIGINT/SIGTERM/SIGHUP 을 자식에게 전달
 *   7. 자식 종료 후 previousActive 로 원복 (swap 했던 경우에만)
 *   8. lock release
 *   9. 자식의 종료 코드/시그널을 그대로 반영해 종료
 *
 * 한계:
 *  - 자식이 시작 시점에 자격증명을 읽어 메모리에 보관하는 경우에만 시간 격리가 유효.
 *    자식이 실행 중 자격증명을 다시 읽으면 원복 후 다른 값을 보게 될 수 있다.
 *  - 외부 SIGKILL 등으로 mat 자체가 강제 종료되면 원복이 일어나지 않는다.
 *    (이 경우 다음 mat 실행 시 활성 포인터는 swap 한 profile 로 남는다.)
 */

import { spawn } from 'node:child_process';

import { findCliDef } from './cli-defs.js';
import { getActiveProfile } from './config.js';
import { errorMessage } from './errors.js';
import { acquireCliLock } from './lockfile.js';
import { profileExists, validateProfileName } from './profile-store.js';
import { switchProfile } from './switcher.js';

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
}

/** 외부에서 잡고 자식에게 전달할 시그널 목록. */
const FORWARD_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

/**
 * mat exec 메인.
 * 검증 실패는 throw, 자식 실행 결과는 ExecResult 로 반환.
 */
export async function runExec(opts: ExecOptions): Promise<ExecResult> {
  const def = findCliDef(opts.cliId);
  if (!def) {
    throw new Error(`알 수 없는 CLI: ${opts.cliId}`);
  }
  const profileName = validateProfileName(opts.profileName);
  if (!(await profileExists(opts.cliId, profileName))) {
    throw new Error(`프로필을 찾을 수 없습니다: ${opts.cliId}/${profileName}`);
  }
  if (!opts.command) {
    throw new Error('실행할 명령이 비어 있습니다. `-- <cmd>` 뒤에 명령을 지정하세요.');
  }

  const previousActive = await getActiveProfile(opts.cliId);
  if (!previousActive) {
    throw new Error(
      `mat exec 는 활성 프로필이 설정된 상태에서만 사용할 수 있습니다. ` +
      `먼저 \`mat\` 으로 라이브 자격증명을 프로필로 가져오세요.`
    );
  }

  const release = await acquireCliLock(opts.cliId, profileName);
  try {
    const swapped = previousActive !== profileName;
    if (swapped) {
      await switchProfile(opts.cliId, profileName);
    }
    try {
      return await spawnAndWait(opts.command, opts.args);
    } finally {
      if (swapped) {
        await restoreSilently(opts.cliId, previousActive);
      }
    }
  } finally {
    await release();
  }
}

/** 자식 spawn + 시그널 forward + 종료 대기. */
function spawnAndWait(command: string, args: string[]): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });

    const forwarders = registerSignalForwarders(child);

    child.on('error', (err) => {
      forwarders.dispose();
      reject(err);
    });

    child.on('exit', (code, signal) => {
      forwarders.dispose();
      resolve({ code, signal });
    });
  });
}

interface SignalForwarders {
  dispose(): void;
}

function registerSignalForwarders(child: ReturnType<typeof spawn>): SignalForwarders {
  const handlers = FORWARD_SIGNALS.map((sig) => {
    const handler = () => {
      // 자식이 이미 종료된 경우 무시.
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

/** previousActive 로 swap 원복. 실패는 stderr 로 안내만 하고 throw 하지 않는다. */
async function restoreSilently(cliId: string, previousActive: string): Promise<void> {
  try {
    await switchProfile(cliId, previousActive);
  } catch (err) {
    process.stderr.write(
      `\n[mat] 원래 프로필(${previousActive}) 로 원복 실패: ${errorMessage(err)}\n` +
      `[mat] 활성 포인터가 swap 한 프로필에 남아 있을 수 있습니다. \`mat\` 으로 확인하세요.\n`
    );
  }
}
