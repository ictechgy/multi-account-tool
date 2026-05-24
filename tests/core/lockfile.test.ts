import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LockHeldError, acquireCliLock } from '../../src/core/lockfile.js';
import { cliLockPath } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

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
    // release 후 lock 디렉토리가 사라진다.
    await expect(fs.access(lockDir)).rejects.toThrow();
  });

  it('서로 다른 cliId 는 동시에 lock 을 획득할 수 있다', async () => {
    const r1 = await acquireCliLock('codex', 'a');
    const r2 = await acquireCliLock('claude', 'b');
    await r1();
    await r2();
  });

  it('동일 cliId 에 대해 살아있는 holder 가 있으면 LockHeldError', async () => {
    const release = await acquireCliLock('codex', 'work');
    try {
      // 같은 프로세스의 pid 는 살아있다 → stale 회수 대상 아님.
      await expect(acquireCliLock('codex', 'other')).rejects.toThrowError(LockHeldError);
      try {
        await acquireCliLock('codex', 'other');
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
    // 실제로 존재하지 않는 PID 로 가짜 lock 디렉토리를 미리 만든다.
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({
        pid: 99999, // 거의 확실히 존재하지 않는 PID
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
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(join(lockDir, 'info.json'), '');

    // 200ms in-flight wait 후에야 stale 판정 → 한 번에 회수 + 획득.
    const release = await acquireCliLock('codex', 'recovered');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.profile).toBe('recovered');
    await release();
  });

  it('info.json 자체가 없는 빈 lock 디렉토리도 stale 로 회수된다', async () => {
    const lockDir = cliLockPath('codex');
    await fs.mkdir(lockDir, { recursive: true, mode: 0o700 });
    // info.json 없이 디렉토리만 생성 (mat 가 SIGKILL 받았을 때 발생 가능)

    const release = await acquireCliLock('codex', 'after-kill');
    const info = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    expect(info.profile).toBe('after-kill');
    await release();
  });

  it('release 는 다른 token 의 lock 을 삭제하지 않는다 (owner token 검증)', async () => {
    const lockDir = cliLockPath('codex');
    const release = await acquireCliLock('codex', 'work');

    // 외부에서 lock 내용을 다른 holder 의 token 으로 교체 (정상 시나리오는 아님 — 방어 검증).
    const original = JSON.parse(await fs.readFile(join(lockDir, 'info.json'), 'utf8'));
    await fs.writeFile(
      join(lockDir, 'info.json'),
      JSON.stringify({ ...original, token: 'someone-else-token' })
    );

    await release();
    // lock 디렉토리는 여전히 존재해야 한다 (다른 owner 의 lock 으로 보임).
    await expect(fs.access(lockDir)).resolves.toBeUndefined();
    // 정리는 테스트가 직접.
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  it('cliId 가 path traversal 형식이면 cliLockPath 단계에서 throw (lock 획득 시도 차단)', async () => {
    await expect(acquireCliLock('../../etc/passwd', 'p')).rejects.toThrow(/path segment/);
  });

  it('동시 acquire 시 정확히 하나만 성공한다', async () => {
    // 같은 프로세스에서 N 개의 mkdir-lock 시도를 동시에 발사.
    // 하나는 acquire 성공, 나머지는 LockHeldError (자기 자신의 pid 이므로 stale 회수 안 됨).
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
    // cleanup
    const release = (fulfilled[0] as PromiseFulfilledResult<() => Promise<void>>).value;
    await release();
  });
});
