import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('readInfo: pid=0 경계값 → isProcessAlive `pid <= 0` 분기 (line 156) + startedAt/profile 부재 시 빈 문자열 fallback (lines 145-146)', async () => {
    // pid=0 은 typeof number ✓ 통과해 readInfo 가 LockBody 반환. isProcessAlive 의 pid<=0
    // boundary 분기 (line 156 short-circuit RHS) 가 true → dead 로 판정 → handleConflict 가 stale 회수.
    // startedAt/profile 필드 부재 → readInfo 의 typeof guard ternary (lines 145-146) 의 else 분기 실행.
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({ pid: 0, token: 'phantom-tok' })  // startedAt/profile 의도적 누락
    );

    const release = await acquireCliLock('codex', 'recovered');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.profile).toBe('recovered');
    expect(info.pid).toBe(process.pid);
    await release();
  });

  it('info.json shape 불일치 (pid/token 타입 mismatch) → readInfo typeof guard 가 null 반환, stale 회수', async () => {
    // 기존 '빈 파일' 케이스는 JSON.parse 자체에서 throw → catch 분기 (line 149).
    // 본 케이스는 유효 JSON 이지만 pid/token 타입이 잘못된 경우 → readInfo 의 typeof guard
    // (line 142) 가 null 반환하는 분기 회귀 가드. 결과적으로 stale 로 회수되어야.
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({ pid: 'wrong-type', token: 123 })
    );

    const release = await acquireCliLock('codex', 'recovered');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.profile).toBe('recovered');
    expect(info.pid).toBe(process.pid);
    await release();
  });

  it('tryAcquire mkdir EACCES → 원본 에러 전파 (line 96 throw err 분기, non-EEXIST)', async () => {
    // locks/ 부모를 0o500 (no write) 로 만들면 mkdir(lockDir) 가 EACCES throw.
    // EEXIST 와 다른 코드이므로 tryAcquire catch 의 `code === 'EEXIST'` 분기를 통과하고
    // line 96 의 `throw err` 가 작동해야 한다. handleConflict 까지 도달하지 않는다.
    const lockDir = cliLockPath('codex');
    const locksDir = dirname(lockDir);
    // lockDir 자체는 사전 생성 안 함 — mkdir 가 EACCES 로 실패하도록.
    await fs.mkdir(locksDir, { recursive: true, mode: 0o700 });
    await fs.chmod(locksDir, 0o500);
    try {
      await expect(acquireCliLock('codex', 'p')).rejects.toThrow();
      // 핵심 회귀 가드: lockDir 가 만들어지지 않았어야 (mkdir 실패).
      expect(existsSync(lockDir)).toBe(false);
    } finally {
      await fs.chmod(locksDir, 0o700);
    }
  });

  it('handleConflict rename EACCES → 원본 에러 전파 (line 128 throw err 분기)', async () => {
    // locks/ 디렉토리를 0o500 (read+exec, no write) 로 만들면 rename(lockDir, stalePath) 가
    // EACCES throw (rename 은 parent 의 write 권한 필요). 이는 ENOENT/ENOTEMPTY/EEXIST 외 경로
    // 의 회귀 가드 — handleConflict catch 의 throw 분기 (line 128).
    const lockDir = cliLockPath('codex');
    const locksDir = dirname(lockDir);
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    // info.json 없음 → readInfo null → rename 단계까지 도달.
    await fs.chmod(locksDir, 0o500);
    try {
      await expect(acquireCliLock('codex', 'p')).rejects.toThrow();
    } finally {
      // tmp 정리 가능하도록 권한 복원.
      await fs.chmod(locksDir, 0o700);
    }
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

/**
 * 도달 어려운 race / 권한 / writeFileAtomic 실패 분기를 vi.doMock + dynamic import 격리로 검증.
 * migrate.test.ts 의 renameSync 실패 분기 패턴과 동일 스타일 — resetModules 로 mock 효과를 명시.
 *
 * 단일 프로세스 결정론적 시나리오로 cross-process fork barrier 없이도 lockfile 의
 * 에러 처리 경로를 회귀 가드 (lines 85-87, 104-105, 125-128 등).
 */
describe('lockfile.acquireCliLock — doMock 시나리오', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock('../../src/core/io-atomic.js');
    vi.doUnmock('node:fs');
    vi.resetModules();
    await tmp.cleanup();
  });

  it('tryAcquire: writeFileAtomic 실패 → 자기 lock 디렉토리 정리 + 원본 에러 전파 (lines 104-105)', async () => {
    // mkdir(lockDir) 은 성공하지만 직후 writeFileAtomic 가 throw 하는 시나리오 (디스크 풀 등).
    // 우리가 만든 빈 디렉토리를 다른 프로세스가 stale 로 오인하지 않도록 cleanup 후 throw.
    const writeMock = vi.fn(async () => { throw new Error('simulated info write fail'); });
    vi.doMock('../../src/core/io-atomic.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/core/io-atomic.js')>(
        '../../src/core/io-atomic.js'
      );
      return { ...actual, writeFileAtomic: writeMock };
    });

    const { acquireCliLock: acl } = await import('../../src/core/lockfile.js');
    const { cliLockPath: lp } = await import('../../src/core/paths.js');

    await expect(acl('codex', 'doomed')).rejects.toThrow(/simulated info write fail/);
    expect(writeMock).toHaveBeenCalledOnce();
    // 핵심 회귀 가드: 자기가 만든 lock dir 이 cleanup 되어야.
    expect(existsSync(lp('codex'))).toBe(false);
  });

  it('handleConflict rename ENOENT → 양보 (swallow), 2회 모두 회수 실패 시 "반복된 race" throw (lines 126, 85, 87)', async () => {
    // ENOENT: 다른 회수자가 우리보다 먼저 lockDir 을 가져간 시나리오.
    // 양 attempt 모두 handleConflict 가 swallow → fall through → fallback line 85 readInfo 는 null
    // (rename mock 이라 실제 lockDir 은 그대로지만 info.json 없음) → line 87 throw.
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    // info.json 없음 → readInfo null → handleConflict 가 rename 시도.

    const renameMock = vi.fn(async () => {
      const err = new Error('ENOENT: simulated other recoverer won') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        promises: { ...actual.promises, rename: renameMock }
      };
    });

    const { acquireCliLock: acl } = await import('../../src/core/lockfile.js');

    await expect(acl('codex', 'p')).rejects.toThrow(/반복된 race/);
    // 2회 시도 → rename 도 2번 호출.
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('handleConflict rename ENOTEMPTY → 양보 (swallow, line 127)', async () => {
    // 매우 드문 POSIX 케이스: stale-suffix 충돌. 동일하게 swallow → fallback "반복된 race".
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });

    const renameMock = vi.fn(async () => {
      const err = new Error('ENOTEMPTY: simulated stale-suffix conflict') as NodeJS.ErrnoException;
      err.code = 'ENOTEMPTY';
      throw err;
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        promises: { ...actual.promises, rename: renameMock }
      };
    });

    const { acquireCliLock: acl } = await import('../../src/core/lockfile.js');

    await expect(acl('codex', 'p')).rejects.toThrow(/반복된 race/);
    expect(renameMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('fallback: handleConflict 가 죽은 pid info 를 재시도 없이 양보하면 readInfo 가 holder 반환 → LockHeldError throw (line 86)', async () => {
    // 정밀 시나리오: info 가 dead pid 라서 handleConflict 는 rename 시도하지만 mock 이 ENOENT 양보.
    // 양 attempt fall through → fallback line 85 의 readInfo 는 같은 info (유효 LockBody) 반환
    // → line 86 의 `if (holder) throw new LockHeldError(...)` 분기 회귀 가드.
    const deadPid = (() => {
      const ghost = spawnSync(process.execPath, ['-e', '']);
      if (ghost.pid === undefined) throw new Error('ghost spawn fail');
      return ghost.pid;
    })();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        profile: 'phantom',
        token: 'ghost-token'
      })
    );

    const renameMock = vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        promises: { ...actual.promises, rename: renameMock }
      };
    });

    const { acquireCliLock: acl, LockHeldError: LHE } = await import('../../src/core/lockfile.js');

    try {
      await acl('codex', 'p');
      expect.fail('LockHeldError 가 던져졌어야 함');
    } catch (err) {
      expect(err).toBeInstanceOf(LHE);
      expect((err as InstanceType<typeof LHE>).cliId).toBe('codex');
      expect((err as InstanceType<typeof LHE>).holder.pid).toBe(deadPid);
      expect((err as InstanceType<typeof LHE>).holder.profile).toBe('phantom');
    }
  });
});
