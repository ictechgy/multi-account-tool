import { promises as fs } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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

  it('tmp 가 symlink 면 O_NOFOLLOW 로 거부 (attacker symlink 추적 차단)', async () => {
    const target = join(dir, 'victim.json');
    const tmpPath = `${target}.tmp`;
    const decoy = join(dir, 'decoy');
    await fs.writeFile(decoy, 'old');
    await symlink(decoy, tmpPath);

    await expect(writeFileAtomic(target, 'attack')).rejects.toThrow();
    // symlink 대상이 변경되지 않았음을 확인 (link 자체는 호출 실패 후 정리될 수 있음).
    expect(await fs.readFile(decoy, 'utf8')).toBe('old');
  });

  it('연속 쓰기에 대해 마지막 쓰기 결과가 보존된다 (rename atomicity)', async () => {
    const target = join(dir, 'seq.json');
    await writeFileAtomic(target, 'A');
    await writeFileAtomic(target, 'B');
    await writeFileAtomic(target, 'C');
    expect(await fs.readFile(target, 'utf8')).toBe('C');
  });
});
