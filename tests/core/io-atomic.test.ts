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
});
