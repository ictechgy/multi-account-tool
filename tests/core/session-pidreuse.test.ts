/**
 * PR #61 H2: stopSession / reapOrphans 의 pid 재사용 방어.
 *
 * session.json 의 시작 서명(pidStart, `ps -o lstart`)을 검증해, pid 가 살아있어도 서명이
 * 다르면(= pid 가 재사용된 무관 프로세스) stopSession 이 그 프로세스를 SIGTERM 하지 않고,
 * reapOrphans 가 stale 세션을 영구 보존하지 않음을 확인한다.
 *
 * 이 파일은 child_process 를 mock 하지 않으므로 실제 `ps` 가 동작한다 (macOS/Linux 타깃).
 * 따라서 `processStartSignature(process.pid)` 가 현재 프로세스의 진짜 서명을 돌려준다.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sessionDir } from '../../src/core/paths.js';
import { processStartSignature, reapOrphans, stopSession } from '../../src/core/session.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await setupTmpHome();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await tmp.cleanup();
});

/** sessionsDir 에 가짜 세션 + session.json(pidStart/childPid 포함) 직접 생성. */
async function makeSession(
  id: string,
  opts: {
    pid: number;
    startedAt: string;
    pidStart?: string;
    childPid?: number;
    childPidStart?: string;
  }
): Promise<string> {
  const dir = sessionDir(id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    join(dir, 'session.json'),
    JSON.stringify({
      id,
      cli: 'codex',
      profile: 'work',
      pid: opts.pid,
      pidStart: opts.pidStart,
      childPid: opts.childPid,
      childPidStart: opts.childPidStart,
      startedAt: opts.startedAt,
      roots: []
    })
  );
  return dir;
}

/** process.kill 을 spy — liveness probe(signal 0)는 실제 위임, SIGTERM 등은 기록만(러너 보호). */
function spyKill(): ReturnType<typeof vi.spyOn> {
  const realKill = process.kill.bind(process);
  return vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
    if (sig === 0) return realKill(pid, 0);
    return true;
  }) as typeof process.kill);
}

const HOUR = 60 * 60 * 1000;

describe('processStartSignature', () => {
  it.each([0, -1, 1.5])(
    '잘못된 pid(%s)는 ps 호출 없이 null 반환',
    async (pid) => {
      await expect(processStartSignature(pid)).resolves.toBeNull();
    }
  );
});

describe('stopSession — pid 재사용 방어 (H2)', () => {
  it('서명 일치 + 살아있음 → SIGTERM (디렉토리는 소유 mat 이 정리하도록 보존)', async () => {
    const sig = await processStartSignature(process.pid);
    expect(sig).toBeTruthy(); // ps 동작 전제 (macOS/Linux)
    await makeSession('codex-work-sig00001', {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      pidStart: sig!
    });
    const kill = spyKill();
    await stopSession('codex-work-sig00001');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
    await expect(fs.access(sessionDir('codex-work-sig00001'))).resolves.toBeUndefined();
  });

  it('서명 불일치(살아있지만 pid 재사용) → SIGTERM 생략 + 세션 정리', async () => {
    const dir = await makeSession('codex-work-sig00002', {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      pidStart: 'v1:Mon Jan  1 00:00:00 2000' // 현재 버전 형식이나 값 불일치 → dead-or-reused
    });
    const kill = spyKill();
    await stopSession('codex-work-sig00002');
    // 무관 프로세스 보호 — liveness probe(signal 0) 외 어떤 종료 신호도 보내지 않음.
    expect(kill.mock.calls.filter(([, s]) => s !== 0)).toEqual([]);
    await expect(fs.access(dir)).rejects.toThrow(); // 세션은 정리됨
  });

  it('옛 형식 pidStart(버전 미접두)는 unknown → 라이브 세션 보존 (#4 migration)', async () => {
    // 살아있는 pid + 버전 접두 없는 옛 형식 서명. ps 는 정상 동작(v1: 반환)하지만 기록값이 비-v1 →
    // 형식 차이를 pid 재사용으로 오인하지 않고 unknown 으로 보존(살아있는 세션 삭제 방지).
    const dir = await makeSession('codex-work-oldfmt01', {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      pidStart: 'Mon Jan  1 00:00:00 2000'
    });
    // ps 가 정상 동작함을 단언 — 보존이 ps 실패(null)가 아니라 '버전 미접두→unknown' 분기에서
    // 왔음을 명확히 한다 (PR #61 3회차 Forge).
    expect(await processStartSignature(process.pid)).toBeTruthy();
    const kill = spyKill();
    await stopSession('codex-work-oldfmt01');
    expect(kill.mock.calls.filter(([, s]) => s !== 0)).toEqual([]); // 종료 신호 0회
    await expect(fs.access(dir)).resolves.toBeUndefined(); // 라이브 가능성 → 보존
  });

  it('서명 미기록(옛 메타) + 살아있음 → liveness-only 폴백으로 SIGTERM', async () => {
    await makeSession('codex-work-sig00005', {
      pid: process.pid,
      startedAt: new Date().toISOString()
      // pidStart 없음 → 기존 동작(서명 검증 생략)
    });
    const kill = spyKill();
    await stopSession('codex-work-sig00005');
    expect(kill).toHaveBeenCalledWith(process.pid, 'SIGTERM');
  });
});

describe('reapOrphans — pid 재사용 방어 (H2)', () => {
  it('서명 불일치(살아있는 pid 재사용) + TTL 초과 → 회수 (stale 영구보존 해소)', async () => {
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const dir = await makeSession('codex-work-sig00003', {
      pid: process.pid,
      startedAt: old,
      pidStart: 'v1:Mon Jan  1 00:00:00 2000' // 현재 버전 형식이나 값 불일치 → dead-or-reused
    });
    const oldTime = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-sig00003');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('서명 일치(소유 프로세스 생존) → TTL 초과여도 보존', async () => {
    const sig = await processStartSignature(process.pid);
    expect(sig).toBeTruthy();
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const dir = await makeSession('codex-work-sig00004', {
      pid: process.pid,
      startedAt: old,
      pidStart: sig!
    });
    const oldTime = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-sig00004');
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });
});

const DEAD_PID = 2147483646; // 사실상 존재하지 않는 pid → isProcessAlive false

describe('reapOrphans / stopSession — 자식 subshell 생존 추적 (#63-2)', () => {
  it('소유 mat 죽음(서명 불일치)이어도 자식 서명 일치(생존) → reapOrphans 보존', async () => {
    const childSig = await processStartSignature(process.pid);
    expect(childSig).toBeTruthy(); // ps 동작 전제
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const dir = await makeSession('codex-work-csig0001', {
      pid: process.pid,
      pidStart: 'v1:Mon Jan  1 00:00:00 2000', // 소유 mat = dead-or-reused(값 불일치)
      childPid: process.pid,
      childPidStart: childSig!, // 자식 = 서명 일치(생존)
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-csig0001'); // 자식 생존 → 라이브 보존
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('소유 mat·자식 모두 죽음(서명 불일치) + TTL 초과 → reapOrphans 회수', async () => {
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const dir = await makeSession('codex-work-csig0002', {
      pid: DEAD_PID, // 소유 mat 죽음
      childPid: DEAD_PID, // 자식도 죽음 → dead-or-reused
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-csig0002');
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('소유 mat 죽음 + 자식 생존이나 childPidStart 미기록(unknown) + UNKNOWN_TTL 초과(25h) → 회수 (#71 결함2·3, 실제 ps)', async () => {
    // 결함2: childPid 는 있으나 childPidStart 가 없으면(서명 미기록) liveness-only 'owner' 금지 →
    // 'unknown'. 결함3: unknown 은 무한 보존하지 않고 UNKNOWN_TTL(24h) bounded 회수. 25h 전 → 회수.
    // 실제 ps 환경에서도 childPidStart 필드 자체가 없으면 unknown 으로 떨어짐을 확인한다.
    const old = new Date(Date.now() - 25 * HOUR).toISOString();
    const dir = await makeSession('codex-work-cunk0001', {
      pid: DEAD_PID, // 소유 mat 죽음 → dead-or-reused
      childPid: process.pid, // 자식 생존(실제 ps 로 살아있음) 이나 childPidStart 미기록 → unknown
      startedAt: old
      // childPidStart 의도적 미기록 — classifyChildOwner 가 'unknown' 을 반환해야 한다(결함2).
    });
    const oldTime = new Date(Date.now() - 25 * HOUR);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).toContain('codex-work-cunk0001'); // unknown 도 24h 초과 → bounded 회수(무한 보존 안 함)
    await expect(fs.access(dir)).rejects.toThrow();
  });

  it('소유 mat 죽음 + 자식 생존이나 childPidStart 미기록(unknown) + UNKNOWN_TTL 미만(2h) → 보존 (#71 결함2·3, 실제 ps)', async () => {
    // 같은 unknown child 라도 24h 미만이면 보존 — 라이브 child 오삭제 방지(긴 TTL).
    const old = new Date(Date.now() - 2 * HOUR).toISOString();
    const dir = await makeSession('codex-work-cunk0002', {
      pid: DEAD_PID, // 소유 mat 죽음 → dead-or-reused
      childPid: process.pid, // 자식 생존이나 childPidStart 미기록 → unknown
      startedAt: old
    });
    const oldTime = new Date(Date.now() - 2 * HOUR);
    await fs.utimes(dir, oldTime, oldTime);
    const reaped = await reapOrphans();
    expect(reaped).not.toContain('codex-work-cunk0002'); // 24h 미만 → 보존
    await expect(fs.access(dir)).resolves.toBeUndefined();
  });

  it('stopSession: 소유 mat 죽음이어도 자식 서명 일치(생존) → 보존', async () => {
    const childSig = await processStartSignature(process.pid);
    expect(childSig).toBeTruthy();
    const dir = await makeSession('codex-work-csig0003', {
      pid: DEAD_PID, // 소유 mat 죽음 → dead-or-reused
      childPid: process.pid,
      childPidStart: childSig!, // 자식 생존
      startedAt: new Date().toISOString()
    });
    const kill = spyKill();
    await stopSession('codex-work-csig0003');
    expect(kill.mock.calls.filter(([, s]) => s !== 0)).toEqual([]); // 종료 신호 0회
    await expect(fs.access(dir)).resolves.toBeUndefined(); // 자식 생존 → 보존
  });
});
