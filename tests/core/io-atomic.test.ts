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
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false);
  });

  it('유효하지만 긴 target basename 도 tmp suffix 때문에 실패하지 않는다', async () => {
    const target = join(dir, 'a'.repeat(240));
    await writeFileAtomic(target, 'ok');
    expect(await fs.readFile(target, 'utf8')).toBe('ok');
    const entries = await fs.readdir(dir);
    expect(entries).toContain('a'.repeat(240));
    expect(entries.some((e) => e.startsWith('.mat-atomic@'))).toBe(false);
  });

  it('legacy deterministic tmp symlink 를 무시하고 unique tmp 로 쓴다', async () => {
    // 예전 `${target}.tmp` deterministic 경로를 공격자가 선점해도, 현재 구현은 nonce tmp 를
    // 사용하므로 decoy 를 건드리지 않고 대상 파일을 정상 교체해야 한다.
    const target = join(dir, 'victim.json');
    const legacyTmpPath = `${target}.tmp`;
    const decoy = join(dir, 'decoy');
    await fs.writeFile(decoy, 'old');
    await symlink(decoy, legacyTmpPath);

    await writeFileAtomic(target, 'attack');
    expect(await fs.readFile(target, 'utf8')).toBe('attack');
    expect(await fs.readFile(decoy, 'utf8')).toBe('old');
    expect((await fs.lstat(legacyTmpPath)).isSymbolicLink()).toBe(true);
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
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
  });

  it('동시 plain replace 도 unique tmp 로 tmp 잔존 없이 완료된다 (RMW serialization 은 호출자 책임)', async () => {
    // writeFileAtomic 은 단일 문자열을 atomic replace 하는 primitive 이다. 같은 path 의
    // read-modify-write 의미 보존/순서화는 config.mutateConfig 같은 상위 호출자 책임.
    // 여기서는 nonce tmp 간 상호 삭제/ENOENT 회귀가 없고, 실패/성공과 무관하게 tmp 가 남지
    // 않는다는 파일 쓰기 primitive invariant 만 검증한다.
    const target = join(dir, 'concurrent.json');
    const settled = await Promise.allSettled([
      writeFileAtomic(target, 'longer-payload-A'),
      writeFileAtomic(target, 'longer-payload-B'),
      writeFileAtomic(target, 'longer-payload-C')
    ]);

    expect(settled.every((r) => r.status === 'fulfilled')).toBe(true);
    const content = await fs.readFile(target, 'utf8');
    expect(['longer-payload-A', 'longer-payload-B', 'longer-payload-C']).toContain(content);
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.includes('.tmp'))).toEqual([]);
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
      expect(mkdir).toHaveBeenCalledWith('/tmp', { recursive: true, mode: 0o700 });
      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.calls[0][0]).toMatch(/^\/tmp\/\.mat-atomic@\d+-[0-9a-f]{16}\.tmp$/);
      expect(handle.writeFile).toHaveBeenCalledWith('secret');
      expect(handle.close).toHaveBeenCalledOnce();
      expect(rmMock.mock.calls[0][0]).toMatch(/^\/tmp\/\.mat-atomic@\d+-[0-9a-f]{16}\.tmp$/);
      expect(rmMock.mock.calls[0][1]).toEqual({ force: true });
      expect(rename).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
    }
  });

});
