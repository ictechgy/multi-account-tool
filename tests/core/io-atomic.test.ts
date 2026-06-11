import { promises as fs } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { writeFileAtomic } from '../../src/core/io-atomic.js';

describe('writeFileAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mat-iotest-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('파일을 생성하고 내용을 정확히 쓴다', async () => {
    const target = join(dir, 'a.json');
    await writeFileAtomic(target, '{"k":"v"}');
    expect(await fs.readFile(target, 'utf8')).toBe('{"k":"v"}');
  });

  it('권한이 0600 으로 설정된다 (다른 사용자 read 차단)', async () => {
    const target = join(dir, 'secret.txt');
    await writeFileAtomic(target, 'secret');
    const stat = await fs.stat(target);
    // mode 의 lower 9 bits 만 비교 (umask 영향 제거).
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('부모 디렉토리가 없으면 자동 생성한다', async () => {
    const target = join(dir, 'nested', 'deep', 'file.json');
    await writeFileAtomic(target, 'hello');
    expect(await fs.readFile(target, 'utf8')).toBe('hello');
  });

  it('이미 존재하는 파일을 덮어쓴다 (atomic replace)', async () => {
    const target = join(dir, 'existing.json');
    await writeFileAtomic(target, 'first');
    await writeFileAtomic(target, 'second');
    expect(await fs.readFile(target, 'utf8')).toBe('second');
  });

  it('성공 후 .tmp 파일이 남지 않는다', async () => {
    const target = join(dir, 'clean.json');
    await writeFileAtomic(target, 'ok');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('clean.json');
    expect(entries.some((e) => e.endsWith('.tmp'))).toBe(false);
  });

  it('tmp 가 symlink 면 open 단계에서 거부, decoy 손상 없음', async () => {
    // writeFileAtomic 의 tmp path 는 `${target}.tmp` 로 결정적이라 미리 symlink 를 깔아두면
    // open(O_EXCL | O_NOFOLLOW) 가 둘 중 하나로 즉시 실패한다.
    // - O_EXCL → EEXIST (tmp 가 이미 존재) — 이게 먼저 잡힌다
    // - O_NOFOLLOW → ELOOP (symlink 추적 차단)
    // 어느 단계든 핵심 invariant 는 "decoy 가 손상되지 않는다" 이므로 그것을 명시 assert.
    const target = join(dir, 'victim.json');
    const tmpPath = `${target}.tmp`;
    const decoy = join(dir, 'decoy');
    await fs.writeFile(decoy, 'old');
    await symlink(decoy, tmpPath);

    await expect(writeFileAtomic(target, 'attack')).rejects.toMatchObject({
      code: expect.stringMatching(/^(EEXIST|ELOOP)$/)
    });
    expect(await fs.readFile(decoy, 'utf8')).toBe('old');
    // O_EXCL/O_NOFOLLOW 두 보호를 분리 검증하려면 별도 단위 테스트가 필요하나, 본 케이스는
    // attacker symlink 가 있을 때 decoy 가 보호된다는 end-to-end invariant 만 보장한다.
  });

  it('연속 쓰기에 대해 마지막 쓰기 결과가 보존된다 (rename atomicity)', async () => {
    const target = join(dir, 'seq.json');
    await writeFileAtomic(target, 'A');
    await writeFileAtomic(target, 'B');
    await writeFileAtomic(target, 'C');
    expect(await fs.readFile(target, 'utf8')).toBe('C');
  });

  it('target 이 디렉토리여서 쓰기가 실패해도 .tmp 가 정리된다', async () => {
    // target=dir 이면 fs.rename(tmp, target) 가 EISDIR/ENOTDIR/ENOTEMPTY 등으로 실패.
    // platform/filesystem 마다 정확한 errno 가 다를 수 있어 화이트리스트로 검증한다.
    // 핵심 invariant 는 "어느 단계든 실패하면 .tmp 가 dir 에 남지 않음" — 후속 atomic
    // 호출이 잔존 .tmp 의 EEXIST 로 깨지지 않게 보장.
    const target = join(dir, 'isdir');
    await fs.mkdir(target);

    let caughtCode: string | undefined;
    try {
      await writeFileAtomic(target, 'data');
      expect.fail('write 가 실패했어야 함');
    } catch (err) {
      caughtCode = (err as NodeJS.ErrnoException).code;
    }
    expect(['EISDIR', 'ENOTDIR', 'ENOTEMPTY', 'EPERM']).toContain(caughtCode);

    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('동시 쓰기는 race 결과와 무관하게 .tmp 잔존 없음 (intentional all-rejected 도 수용)', async () => {
    // io-atomic.ts contract (모듈 상단 주석): 호출자가 같은 path 에 동시 호출하지 않도록
    // 보장해야 한다. 본 테스트는 그 contract 를 위배했을 때의 안전망 검증:
    //   - 호출 A 가 open(tmp) 성공 후 호출 B 가 open(tmp) → EEXIST → B 가 catch 에서 rm(tmp)
    //   - 호출 A 의 rename 이 ENOENT 로 실패. 모든 호출이 실패할 수 있음 (intentional contract 위배 결과).
    //
    // 의도된 invariant 두 가지를 모두 명시 assert (silent pass 차단):
    //  1) settled 결과의 모든 rejection 은 알려진 EEXIST/ENOENT 계열 — unexpected 에러 없음
    //  2) 결과와 무관하게 .tmp 는 dir 에 남지 않음
    const target = join(dir, 'concurrent.json');
    const settled = await Promise.allSettled([
      writeFileAtomic(target, 'longer-payload-A'),
      writeFileAtomic(target, 'longer-payload-B'),
      writeFileAtomic(target, 'longer-payload-C')
    ]);

    for (const r of settled) {
      if (r.status === 'rejected') {
        const code = (r.reason as NodeJS.ErrnoException).code;
        expect(['EEXIST', 'ENOENT', 'EPERM']).toContain(code);
      }
    }
    const fileExists = await fs.access(target).then(() => true).catch(() => false);
    if (fileExists) {
      const content = await fs.readFile(target, 'utf8');
      expect(['longer-payload-A', 'longer-payload-B', 'longer-payload-C']).toContain(content);
    }
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('writeFile 실패 시 열린 handle close 와 tmp cleanup 을 best-effort 로 시도하고 원본 에러를 보존한다', async () => {
    vi.resetModules();
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const writeErr = new Error('write failed');
    const closeErr = new Error('close failed');
    const rmErr = new Error('rm failed');
    const handle = {
      writeFile: vi.fn().mockRejectedValue(writeErr),
      close: vi.fn().mockRejectedValue(closeErr)
    };
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const open = vi.fn().mockResolvedValue(handle);
    const rename = vi.fn().mockResolvedValue(undefined);
    const rmMock = vi.fn().mockRejectedValue(rmErr);

    vi.doMock('node:fs', () => ({
      ...realFs,
      constants: realFs.constants,
      promises: {
        mkdir,
        open,
        rename,
        rm: rmMock
      }
    }));

    try {
      const { writeFileAtomic: mockedWriteFileAtomic } = await import('../../src/core/io-atomic.js');

      await expect(mockedWriteFileAtomic('/tmp/mat-secret.json', 'secret')).rejects.toBe(writeErr);
      expect(mkdir).toHaveBeenCalledWith('/tmp', { recursive: true });
      expect(open).toHaveBeenCalledOnce();
      expect(handle.writeFile).toHaveBeenCalledWith('secret');
      expect(handle.close).toHaveBeenCalledOnce();
      expect(rmMock).toHaveBeenCalledWith('/tmp/mat-secret.json.tmp', { force: true });
      expect(rename).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

});
