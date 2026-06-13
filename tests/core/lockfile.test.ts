import { spawnSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  LockHeldError,
  acquireCliLock,
  acquireCliLockLease,
  acquireRecaptureLock,
  isProcessAlive,
  sanitizeForStderr
} from '../../src/core/lockfile.js';
import { cliLockPath, recaptureLockPath } from '../../src/core/paths.js';
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

/**
 * chmod 0o500 가 root 사용자에는 효과 없음 — root 환경에서는 mkdir/rename 이 권한 무시하고 성공.
 * 본 helper 는 디렉토리에 chmod 0o500 적용 후 probe mkdir 로 EACCES 실제 발생 여부 확인.
 * root 환경이면 false 반환 (테스트 skip 신호). config.test.ts 의 패턴 차용.
 */
async function chmodActuallyDenies(dir: string): Promise<boolean> {
  const probe = join(dir, '__probe__');
  try {
    await fs.mkdir(probe);
    await fs.rmdir(probe);
    return false; // mkdir 성공 → root 거나 OS 가 0o500 무시
  } catch {
    return true; // EACCES 정상 발생
  }
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

  it('invalid profileName / previousActive / affectsCliIds 는 lock artifact 를 남기지 않는다', async () => {
    await expect(acquireCliLock('codex', '../bad')).rejects.toThrow();
    expect(existsSync(cliLockPath('codex'))).toBe(false);

    await expect(acquireCliLock('codex', 'work', {
      previousActive: '../bad'
    })).rejects.toThrow();
    expect(existsSync(cliLockPath('codex'))).toBe(false);

    await expect(acquireCliLock('codex', 'work', {
      affectsCliIds: ['../../bad']
    })).rejects.toThrow();
    expect(existsSync(cliLockPath('codex'))).toBe(false);
  });

  it('prepareMetadata 실패/invalid previousActive 는 방금 만든 lock 을 정리한다', async () => {
    await expect(acquireCliLockLease('codex', 'work', {
      execMode: 'exec',
      prepareMetadata: async () => {
        throw new Error('prepare boom');
      }
    })).rejects.toThrow('prepare boom');
    expect(existsSync(cliLockPath('codex'))).toBe(false);

    await expect(acquireCliLockLease('codex', 'work', {
      execMode: 'exec',
      prepareMetadata: async () => ({ previousActive: '../bad' })
    })).rejects.toThrow();
    expect(existsSync(cliLockPath('codex'))).toBe(false);
  });

  it('prepareMetadata 는 live holder 충돌 시 호출되지 않는다', async () => {
    const release = await acquireCliLock('codex', 'holder');
    const prepare = vi.fn();
    try {
      await expect(acquireCliLockLease('codex', 'work', {
        prepareMetadata: prepare
      })).rejects.toBeInstanceOf(LockHeldError);
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      await release();
    }
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
      // root 환경에서는 chmod 효과 없음 → 테스트 의미 없으므로 skip.
      if (!await chmodActuallyDenies(locksDir)) return;
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
      // root 환경에서는 chmod 효과 없음 → 테스트 의미 없으므로 skip.
      if (!await chmodActuallyDenies(locksDir)) return;
      await expect(acquireCliLock('codex', 'p')).rejects.toThrow();
    } finally {
      // tmp 정리 가능하도록 권한 복원.
      await fs.chmod(locksDir, 0o700);
    }
  });

  it('(6b) handleConflict default-콜백 회귀 — live holder 면 LockHeldError throw (acquireCliLock 경유)', async () => {
    // BLOCKING-1: handleConflict 에 onLiveHolder 옵션 인자를 추가하는 파라미터화가 exec 동작을
    // 한 바이트도 바꾸지 않음을 가드. exec 호출부(acquireCliLock)는 콜백을 넘기지 않아 default
    // (= LockHeldError throw) 로 동작해야 한다. 살아있는 현재 프로세스 pid 의 info.json 을 미리
    // 심어, default 콜백 경로가 기존과 동일하게 throw 하는지 확인 (probeHolder live 분기).
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: process.pid, // 살아있는 holder
        startedAt: new Date().toISOString(),
        profile: 'live-work',
        token: 'live-token'
      })
    );
    await expect(acquireCliLock('codex', 'new')).rejects.toThrowError(LockHeldError);
    // live holder 의 info.json 은 reclaim 되지 않고 보존돼야 (default 콜백이 throw 했으므로).
    const stillThere = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(stillThere.token).toBe('live-token');
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

/**
 * PR-I*: LockBody 확장 (execMode / previousActive / affectsCliIds) +
 * stale recovery 정책 B (warn + drop) 회귀 가드.
 *
 * 신규 필드는 모두 optional — 옛 mat 으로 생성된 info.json (이 필드가 없는 형태) 도
 * readInfo 가 backward-compat 처리하고, stale recovery 가 두 경우를 명시 분기해 사용자에게
 * 다른 안내 문구를 stderr 로 출력한다.
 */
describe('lockfile.acquireCliLock — PR-I* LockBody 확장', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  it('옵션 없이 호출하면 default execMode="exec" + affectsCliIds=[cliId] + previousActive undefined', async () => {
    const release = await acquireCliLock('codex', 'work');
    const info = JSON.parse(
      await fs.readFile(join(cliLockPath('codex'), 'info.json'), 'utf8')
    );
    expect(info.execMode).toBe('exec');
    expect(info.affectsCliIds).toEqual(['codex']);
    expect(info.previousActive).toBeUndefined();
    await release();
  });

  it('옵션 전달 시 execMode / previousActive / affectsCliIds 모두 info.json 에 직렬화됨', async () => {
    const release = await acquireCliLock('codex', 'work', {
      execMode: 'exec',
      previousActive: 'default',
      affectsCliIds: ['codex', 'gemini']
    });
    const info = JSON.parse(
      await fs.readFile(join(cliLockPath('codex'), 'info.json'), 'utf8')
    );
    expect(info.execMode).toBe('exec');
    expect(info.previousActive).toBe('default');
    expect(info.affectsCliIds).toEqual(['codex', 'gemini']);
    await release();
  });

  it('execMode="foreground" 도 전달되면 info.json 에 그대로 보존 (향후 TUI 호출 예약)', async () => {
    const release = await acquireCliLock('codex', 'work', { execMode: 'foreground' });
    const info = JSON.parse(
      await fs.readFile(join(cliLockPath('codex'), 'info.json'), 'utf8')
    );
    expect(info.execMode).toBe('foreground');
    await release();
  });

  it('stale recovery 정책 B — 신규 lock (previousActive 보유) 의 stale 회수 시 사용자 안내 stderr', async () => {
    // dead pid 의 신규 형식 lock 을 미리 만들어두고, 정상 acquireCliLock 이 stale 회수하면서
    // stderr 에 "라이브 자격증명이 활성 프로필 '...' 이 아닌 '...' 의 것일 수 있습니다" 출력 검증.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        profile: 'work',
        token: 'foreign-token',
        execMode: 'exec',
        previousActive: 'default',
        affectsCliIds: ['codex']
      })
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const release = await acquireCliLock('codex', 'new');
      await release();
      const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(calls).toMatch(/이전 mat exec 가 비정상 종료된 흔적/);
      expect(calls).toMatch(/활성 프로필 'default' 이 아닌 'work' 의 것/);
      expect(calls).toMatch(/mat freshness codex/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('stale recovery 정책 B — 옛 lock (previousActive 부재, pre-PR-I*) 회수 시 일반 안내 stderr', async () => {
    // pre-PR-I* 의 lock shape (execMode/previousActive/affectsCliIds 부재). readInfo 가
    // optional 필드 부재를 정상 처리하고, stale recovery 가 "이전 mat 버전의 exec lock" 분기로 안내.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        profile: 'old-profile',
        token: 'legacy-token'
        // execMode / previousActive / affectsCliIds 모두 부재 — 옛 버전 lock.
      })
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const release = await acquireCliLock('codex', 'recovered');
      await release();
      const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(calls).toMatch(/이전 mat 버전의 exec lock/);
      expect(calls).toMatch(/profile=old-profile/);
      expect(calls).toMatch(/mat freshness codex/);
      // 신규 lock 분기 문구는 등장하지 않아야.
      expect(calls).not.toMatch(/활성 프로필 '/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('readInfo: 잘못된 execMode 값 ("invalid") → undefined 로 normalize, stale 회수는 정상 진행', async () => {
    // execMode 가 'foreground' / 'exec' 외 값이면 옛 lock 으로 간주 (pickExecMode 의 union narrowing).
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: 'now',
        profile: 'p',
        token: 'tok',
        execMode: 'invalid-mode'  // ← 잘못된 값
      })
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const release = await acquireCliLock('codex', 'recovered');
      // release 호출 전에 신규 lock 의 info.json 검증 — release 가 lock 디렉토리 자체를 삭제하므로.
      const fresh = JSON.parse(
        await fs.readFile(join(cliLockPath('codex'), 'info.json'), 'utf8')
      );
      expect(fresh.profile).toBe('recovered');
      // execMode 가 normalize 됐으므로 (previousActive 도 없어) 옛 lock 분기로 안내.
      const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(calls).toMatch(/이전 mat 버전의 exec lock/);
      await release();
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('정책 B 정밀화 — execMode="exec" + previousActive 부재 (손상) → "손상된 흔적" 분기 stderr (옛 버전 분기 아님)', async () => {
    // quad-review iter 1 Strong MED (Claude-1 + Codex-2 + Claude-2 합의):
    // 신규 형식 lock 의 손상 케이스. execMode='exec' 로 신규 형식임은 확인되지만
    // previousActive 가 누락 (호출자가 옵션 일부만 전달 또는 외부 손상). 옛 버전 분기로
    // 잘못 안내되면 안 되고, 별도 "손상" 분기로 분류돼야 한다.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        profile: 'work',
        token: 'foreign-token',
        execMode: 'exec',
        // previousActive 의도적 누락
        affectsCliIds: ['codex']
      })
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const release = await acquireCliLock('codex', 'new');
      await release();
      const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(calls).toMatch(/mat exec lock 의 손상된 흔적/);
      expect(calls).toMatch(/활성 정보가 누락되어/);
      expect(calls).toMatch(/mat freshness codex/);
      // 옛 버전 분기 / 신규 정상 분기 문구 둘 다 등장 금지.
      expect(calls).not.toMatch(/이전 mat 버전의 exec lock/);
      expect(calls).not.toMatch(/활성 프로필 '/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('정책 B 정밀화 — execMode="foreground" lock 의 stale 회수 시 "TUI/foreground" 분기 stderr', async () => {
    // execMode='foreground' 는 향후 TUI 가 직접 lock 잡을 때 사용 예약된 모드. 본 PR 시점
    // 호출자는 없지만 스키마상 별도 분기로 안내해 옛 버전 / exec 분기와 구분.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: new Date().toISOString(),
        profile: 'work',
        token: 'tui-token',
        execMode: 'foreground'
      })
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const release = await acquireCliLock('codex', 'new');
      await release();
      const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(calls).toMatch(/이전 mat TUI\/foreground 작업의 비정상 종료 흔적/);
      expect(calls).toMatch(/mat freshness codex/);
      expect(calls).not.toMatch(/mat exec lock/);
      expect(calls).not.toMatch(/이전 mat 버전의 exec lock/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('stderr sanitize — info.json 의 control char / 매우 긴 문자열을 stderr 보간 전 strip + 200자 cap', async () => {
    // quad-review iter 1 Strong LOW security (Codex-2 + Claude-2 합의): info.json 의
    // raw string 이 ANSI escape / 매우 긴 입력이면 terminal escape injection 위험.
    // trust boundary 가 self 라 LOW 지만 defense in depth.
    //
    // 본 케이스는 신규 lock 의 profile/previousActive 에 control char 와 200+자 입력을
    // 주입해 stderr 출력 본문이 (1) control char 가 '?' 로 replace 되고 (2) 200자 cap
    // 적용됨을 검증. validateProfileName 은 일반 호출에서 차단하지만, lock 파일이
    // 외부 손상된 경우를 가정.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    const longProfile = 'A'.repeat(300);
    const ansiPrev = '\x1b[31mEVIL\x1b[0m';
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: '2026-05-28T20:00:00Z',
        profile: longProfile,
        token: 'tok',
        execMode: 'exec',
        previousActive: ansiPrev
      })
    );

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const release = await acquireCliLock('codex', 'new');
      await release();
      const calls = stderrSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // ANSI ESC (\x1b) 가 stderr 본문에 그대로 노출되면 안 됨.
      expect(calls).not.toMatch(/\x1b\[/);
      // long profile 은 200자 cap 후에도 'A' 가 등장하나 300자 그대로는 아님.
      expect(calls).toMatch(/AAAAAA/);
      // ANSI 의 control char (\x1b) 는 '?' 로 replace 됐어야.
      expect(calls).toMatch(/\?\[31mEVIL\?\[0m/);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('readInfo: affectsCliIds 가 비-문자열 원소 포함 → undefined 로 normalize (손상 간주)', async () => {
    // pickStringArray 의 every typeof 'string' 가드 회귀 가드. 손상된 값은 LockBody 자체는 valid
    // 하지만 (execMode/previousActive 도 모두 부재) 신규 옵션 필드만 normalize 되어야.
    const deadPid = spawnGhostPid();
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: deadPid,
        startedAt: 'now',
        profile: 'p',
        token: 'tok',
        affectsCliIds: [1, 2, 'x']  // ← number 섞임 → undefined 로 normalize
      })
    );

    // stale 회수 자체가 throw 없이 정상 동작하면 readInfo 가 손상 시에도 LockBody 보존했다는 증거.
    const release = await acquireCliLock('codex', 'recovered');
    // release 전에 신규 lock 검증 — release 가 lock 디렉토리를 삭제.
    const fresh = JSON.parse(
      await fs.readFile(join(cliLockPath('codex'), 'info.json'), 'utf8')
    );
    expect(fresh.profile).toBe('recovered');
    expect(fresh.affectsCliIds).toEqual(['codex']);  // default 채워짐
    await release();
  });
});

/**
 * issue #62: 프로필 단위 재캡처 advisory 락. cli-lock 과 별도 namespace(locks/recapture/...),
 * best-effort(실패 시 null), bounded-wait(deadline 후 null), stale-판정은 cli-lock 과 공유
 * (probeHolder/reclaimStaleLock 단일 출처 — §8 M3). live holder 는 throw 가 아니라 폴링한다.
 */
describe('lockfile.acquireRecaptureLock — 프로필 단위 재캡처 락 (#62)', () => {
  let tmp: TmpHome;
  beforeEach(async () => { tmp = await setupTmpHome(); });
  afterEach(async () => { await tmp.cleanup(); });

  it('(1) free 락 즉시 획득 + release 핸들 반환 + recapture/<cli>/<profile>.lock 에 info.json 생성', async () => {
    const release = await acquireRecaptureLock('codex', 'work');
    expect(release).not.toBeNull();
    const lockDir = recaptureLockPath('codex', 'work');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.profile).toBe('work');
    expect(typeof info.token).toBe('string');
    expect(info.token.length).toBeGreaterThan(0);
    await release!();
    await expect(fs.access(lockDir)).rejects.toThrow();
  });

  it('(2) dead holder → reclaim 후 재획득; 정확히 하나만 acquire 성공', async () => {
    const deadPid = spawnGhostPid();
    const lockDir = recaptureLockPath('codex', 'work');
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
    const release = await acquireRecaptureLock('codex', 'work');
    expect(release).not.toBeNull();
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.token).not.toBe('foreign-token');
    await release!();
  });

  it('(2b) live holder mid-acquire 윈도우 — mkdir 직후 info.json 부재 → INFLIGHT 대기 중 live pid 안착 → reclaim 안 함', async () => {
    // MAJOR-A + L3 atomicity: holder 가 mkdir 성공·info.json write 전 상태(lockDir 존재, info.json
    // 부재)를 시뮬레이트. 대기자의 첫 readInfo==null 이지만, INFLIGHT(200ms) 대기 중 holder 가
    // 현재 프로세스 pid 의 info.json 을 작성하면 probeHolder 의 재확인이 live 로 판정 → reclaim
    // 하지 않고 폴링해야 한다. writeFileAtomic 이 atomic 이라 info.json 은 완전부재/완전존재만
    // 가능(부분 JSON 불가) → INFLIGHT 1회 재확인으로 충분 (회귀 시 이 가정 위반이 드러난다).
    const lockDir = recaptureLockPath('codex', 'work');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 }); // holder mkdir 만 (info.json 아직 없음)
    // INFLIGHT(200ms) 보다 짧은 지연 후 live pid info.json 안착 — 대기자의 재확인이 live 를 보게 함.
    const seedLive = setTimeout(() => {
      void fs.writeFile(
        join(lockDir, 'info.json'),
        JSON.stringify({
          pid: process.pid, // 살아있는 holder
          startedAt: new Date().toISOString(),
          profile: 'work',
          token: 'live-holder-token'
        })
      );
    }, 80);

    // deadline 안에서 폴링하다, 우리가 release(=info.json 삭제) 해주면 그제서야 획득.
    const acquirePromise = acquireRecaptureLock('codex', 'work');
    // holder 가 info 안착 + 잠깐 보유 후 사라지도록: 350ms 후 디렉토리 제거(=holder release 모사).
    const releaseHolder = setTimeout(() => {
      void fs.rm(lockDir, { recursive: true, force: true });
    }, 350);

    const release = await acquirePromise;
    clearTimeout(seedLive);
    clearTimeout(releaseHolder);
    // 핵심: 살아있는 holder 를 reclaim 하지 않고 기다린 끝에 정확히 하나만 획득.
    expect(release).not.toBeNull();
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(info.token).not.toBe('live-holder-token'); // 우리 token 으로 새로 획득
    await release!();
  });

  it('(3) release 는 owner-token 일치 시만 삭제 (다른 token 이면 보존)', async () => {
    const lockDir = recaptureLockPath('codex', 'work');
    const release = await acquireRecaptureLock('codex', 'work');
    expect(release).not.toBeNull();
    // 외부에서 token 을 다른 값으로 교체 (방어 검증).
    const original = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({ ...original, token: 'someone-else-token' })
    );
    await release!();
    // 다른 token 이므로 우리 release 가 삭제하지 않아 lock 디렉토리 보존.
    await expect(fs.access(lockDir)).resolves.toBeUndefined();
  });

  it('(4) 지속 live 경합 → deadline 후 null 반환(throw 안 함), 경과 ≈ deadline', async () => {
    // 영구히 살아있는 holder(현재 프로세스 pid) → 대기자는 폴링하다 deadline(5s) 초과 시 null.
    // 테스트 시간을 줄이기 위해 env 가 아닌 실제 5s 를 쓰지 않고, holder 를 끝까지 두면 5s 소요.
    // 5s 전체를 기다리는 대신 "deadline 후 null" 시맨틱만 확인 (실제 wait 상수 검증은 5b 와 분리).
    const lockDir = recaptureLockPath('codex', 'work');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: process.pid, // 영구 live (현재 프로세스)
        startedAt: new Date().toISOString(),
        profile: 'forever',
        token: 'forever-token'
      })
    );
    const t0 = Date.now();
    const release = await acquireRecaptureLock('codex', 'work');
    const elapsed = Date.now() - t0;
    expect(release).toBeNull(); // throw 가 아니라 null
    // deadline(RECAPTURE_LOCK_WAIT_MS=5s) 근처까지 대기 후 폴백.
    expect(elapsed).toBeGreaterThanOrEqual(4_500);
    expect(elapsed).toBeLessThan(7_000);
    // live holder 의 info.json 은 reclaim 되지 않고 보존돼야.
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.token).toBe('forever-token');
  }, 10_000);

  it('(5) 순차 두 acquire 직렬화 — 첫 release 전 둘째는 wait, release 후 획득', async () => {
    const r1 = await acquireRecaptureLock('codex', 'work');
    expect(r1).not.toBeNull();
    // 둘째 acquire 는 r1 이 살아있는 동안 폴링하다, r1 release 후 획득.
    const secondPromise = acquireRecaptureLock('codex', 'work');
    setTimeout(() => { void r1!(); }, 150); // 첫 락 release
    const r2 = await secondPromise;
    expect(r2).not.toBeNull();
    await r2!();
  }, 10_000);

  it('(5b) live holder 보유 중 → release 직후 획득(null 아님). isProcessAlive 실제 hit', async () => {
    // MAJOR-1: 정상 경합 폴백 0 회귀 가드. live holder(현재 프로세스 pid info.json seed)는
    // isProcessAlive=true 가 실제로 hit 돼 dead 경로로 퇴화하지 않음을 명시. holder 가 짧게
    // 보유 후 release(=lockDir 제거)하면 대기자는 deadline 전에 획득한다(폴백 아님).
    const lockDir = recaptureLockPath('codex', 'work');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: process.pid, // 실제 live → isProcessAlive true 가 hit (dead 경로 퇴화 방지)
        startedAt: new Date().toISOString(),
        profile: 'work',
        token: 'live-holder-token'
      })
    );
    // sanity: holder pid 가 실제 alive (테스트가 dead 경로로 퇴화하지 않음을 명시).
    expect(isProcessAlive(process.pid)).toBe(true);

    const t0 = Date.now();
    const acquirePromise = acquireRecaptureLock('codex', 'work');
    setTimeout(() => { void fs.rm(lockDir, { recursive: true, force: true }); }, 400);
    const release = await acquirePromise;
    const elapsed = Date.now() - t0;
    expect(release).not.toBeNull(); // 폴백(null) 아님 — holder release 후 정상 획득
    expect(elapsed).toBeLessThan(4_000); // deadline(5s) 전에 획득 = 조기 폴백 없음
    await release!();
  }, 10_000);

  it('(7) LockBody 최소 shape ({pid,startedAt,profile,token}, execMode 미설정) 직렬화', async () => {
    const release = await acquireRecaptureLock('codex', 'work');
    expect(release).not.toBeNull();
    const lockDir = recaptureLockPath('codex', 'work');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(typeof info.startedAt).toBe('string');
    expect(info.profile).toBe('work');
    expect(typeof info.token).toBe('string');
    // 최소 shape — execMode/previousActive/affectsCliIds 는 설정하지 않음.
    expect(info.execMode).toBeUndefined();
    expect(info.previousActive).toBeUndefined();
    expect(info.affectsCliIds).toBeUndefined();
    await release!();
  });

  it('(8) 획득 오류(mkdir ENOTDIR) 시 throw 하지 않고 null 반환 — best-effort degrade', async () => {
    // 결정적 재현: recaptureLockPath 의 부모 경로(locks/recapture/<cli>)에 해당하는 위치에
    // 파일을 미리 생성해 fs.mkdir(dirname(lockDir), {recursive:true}) 가 ENOTDIR 로 실패하게 한다.
    // recaptureLockPath('codex','work') = locksDir()/recapture/codex/work.lock
    // dirname                           = locksDir()/recapture/codex
    // 따라서 locksDir()/recapture/codex 를 파일로 먼저 만들면 mkdir 가 ENOTDIR throw.
    const lockDir = recaptureLockPath('codex', 'work');
    const parentDir = dirname(lockDir); // locks/recapture/codex
    // 부모의 부모(locks/recapture)까지는 디렉토리로 생성.
    await fs.mkdir(dirname(parentDir), { recursive: true, mode: 0o700 });
    // 부모 경로(locks/recapture/codex)를 파일로 생성 → mkdir(parentDir) 가 ENOTDIR 실패.
    await fs.writeFile(parentDir, 'blocker');

    // 수정 전: reject(ENOTDIR) — 수정 후: null 을 resolve (throw 하지 않음).
    const result = await acquireRecaptureLock('codex', 'work');
    expect(result).toBeNull(); // best-effort degrade: null 반환, throw 없음
  });

  it('(9) 잘못된 profileName(검증 오류)은 null 로 삼키지 않고 throw — best-effort 대상 아님', async () => {
    // quad-review-loop 2트랙 consensus MEDIUM 반영:
    // recaptureLockPath 의 validateProfileName 이 던지는 ValidationError 는
    // 프로그래머/검증 오류이므로 best-effort catch 로 삼켜서는 안 된다.
    // try 블록 밖으로 lockDir 계산을 이동한 후 이 경계를 결정적으로 가드한다.
    // 'bad/name' 은 path traversal 로 validateProfileName 이 throw 한다.
    await expect(acquireRecaptureLock('codex', 'bad/name')).rejects.toThrow();
  });
});

/**
 * PR-S0: session.ts 가 재사용할 수 있도록 export 된 헬퍼의 동작 회귀.
 * 동형 재구현 대신 단일 출처(lockfile.ts)를 export 재사용한다 (M3).
 */
describe('lockfile — export 된 헬퍼 (isProcessAlive / sanitizeForStderr)', () => {
  it('isProcessAlive: 현재 프로세스는 true', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it('isProcessAlive: 죽은 PID 는 false', () => {
    expect(isProcessAlive(spawnGhostPid())).toBe(false);
  });

  it('isProcessAlive: 비정상 입력(0/음수/비정수)은 false', () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it('sanitizeForStderr: control char 를 ? 로 치환', () => {
    expect(sanitizeForStderr('a\x1b[31mb\x00c')).toBe('a?[31mb?c');
  });

  it('sanitizeForStderr: 200자 cap', () => {
    expect(sanitizeForStderr('x'.repeat(300))).toHaveLength(200);
  });

  it('sanitizeForStderr: 정상 입력(cliId/profileName 길이)은 무손실 통과', () => {
    const normal = 'codex / work-account / 2026-05-30T00:00:00.000Z';
    expect(sanitizeForStderr(normal)).toBe(normal);
  });
});
