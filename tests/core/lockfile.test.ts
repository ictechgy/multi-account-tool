import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LockHeldError, acquireCliLock } from '../../src/core/lockfile.js';
import { cliLockPath } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

/**
 * 거의 확실히 죽은 PID 를 확보한다.
 * 즉시 종료되는 자식을 spawnSync 로 띄우고 그 PID 를 반환 — 호출 시점에는 이미 dead.
 * 99999 같은 하드코딩 값보다 OS 별 PID 할당 가정에 덜 의존적.
 */
function spawnGhostPid(): number {
  const ghost = spawnSync(process.execPath, ['-e', '']);
  if (ghost.pid === undefined) throw new Error('ghost 자식을 spawn 하지 못함');
  return ghost.pid;
}

describe('lockfile.acquireCliLock', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  it('새 lock 획득에 성공하고 release 핸들을 반환한다', async () => {
    const release = await acquireCliLock('codex', 'work');
    const lockDir = cliLockPath('codex');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.profile).toBe('work');
    expect(typeof info.token).toBe('string');
    expect(info.token.length).toBeGreaterThan(0);
    await release();
    await expect(fs.access(lockDir)).rejects.toThrow();
  });

  it('서로 다른 cliId 는 동시에 lock 을 획득할 수 있다', async () => {
    const r1 = await acquireCliLock('codex', 'a');
    const r2 = await acquireCliLock('claude', 'b');
    await r1();
    await r2();
  });

  it('동일 cliId 에 대해 살아있는 holder 가 있으면 LockHeldError 가 던져진다 (assertion 강제)', async () => {
    const release = await acquireCliLock('codex', 'work');
    try {
      // 첫 호출 — rejects matcher 로 1차 검증
      await expect(acquireCliLock('codex', 'other')).rejects.toThrowError(LockHeldError);

      // 두 번째 호출 — holder 의 pid/profile 같은 inner 필드까지 확인.
      // expect.assertions 로 catch 미진입 시 silent pass 방지.
      expect.assertions(6);
      try {
        await acquireCliLock('codex', 'other');
        expect.fail('LockHeldError 가 던져졌어야 함');
      } catch (err) {
        expect(err).toBeInstanceOf(LockHeldError);
        const lhe = err as LockHeldError;
        expect(lhe.exitCode).toBe(75);
        expect(lhe.cliId).toBe('codex');
        expect(lhe.holder.pid).toBe(process.pid);
        expect(lhe.holder.profile).toBe('work');
      }
    } finally {
      await release();
    }
  });

  it('죽은 pid 의 stale lock 은 회수되어 재획득 가능', async () => {
    // 환경 의존 하드코딩(예: 99999) 대신 spawnSync 로 즉시 종료된 PID 확보 — 거의 확실히 dead.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        profile: 'old',
        token: 'foreign-token'
      })
    );

    const release = await acquireCliLock('codex', 'new');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.profile).toBe('new');
    expect(info.token).not.toBe('foreign-token');
    await release();
  });

  it('corrupt info.json (빈 파일) 도 stale 로 처리되어 회수된다', async () => {
    // 200ms in-flight wait 후 stale 판정 — 실제 fs/timer 와 함께 한 번에 검증 (fake timer 대신 real).
    // fake timer 는 setImmediate/promise microtask 와 섞일 때 잘 안 맞으므로 본 케이스는 real time 유지.
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(lockDir, 'info.json'), '');

    const release = await acquireCliLock('codex', 'recovered');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.profile).toBe('recovered');
    await release();
  });

  it('info.json 자체가 없는 빈 lock 디렉토리도 stale 로 회수된다', async () => {
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    // mat 가 SIGKILL 로 죽었을 때 발생할 수 있는 상황 — info.json 없이 디렉토리만 남음.

    const release = await acquireCliLock('codex', 'after-kill');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.profile).toBe('after-kill');
    await release();
  });

  it('release 는 다른 token 의 lock 을 삭제하지 않는다 (owner token 검증)', async () => {
    const lockDir = cliLockPath('codex');
    const release = await acquireCliLock('codex', 'work');

    // 외부에서 lock 내용을 다른 holder 의 token 으로 교체 (정상 시나리오 아님 — 방어 검증).
    const original = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({ ...original, token: 'someone-else-token' })
    );

    await release();
    // tmp.cleanup() 이 어차피 tmp HOME 전체를 지우므로 manual rm 은 생략.
    await expect(fs.access(lockDir)).resolves.toBeUndefined();
  });

  it('cliId 가 path traversal 형식이면 cliLockPath 단계에서 throw', async () => {
    await expect(acquireCliLock('../../etc/passwd', 'p')).rejects.toThrow(/path segment/);
  });

  it('단일 프로세스 내 연속 acquire 는 정확히 하나만 성공한다 (cross-process race 는 별도 시나리오)', async () => {
    // single-process 한계 명시: V8 single-thread microtask 큐 특성상 사실상 직렬이라
    // OS-level mkdir race 자체는 검증하지 못한다. 다만 "두 번째 acquire 가 LockHeldError" 라는
    // contract 는 동일 process 시나리오에서도 그대로 적용되므로 유효한 회귀 가드.
    // 진짜 cross-process race 는 child_process.fork 가 필요하며 별도 follow-up 테스트 대상.
    const N = 5;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => acquireCliLock('codex', `p${Math.random()}`))
    );
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(N - 1);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(LockHeldError);
    }
    const release = (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value;
    await release();
  });
});
