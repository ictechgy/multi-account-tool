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

  it('rename 실패 시 .tmp 가 정리된다 (Quad-review V)', async () => {
    // target 이 기존 디렉토리이면 fs.rename(file, dir) 가 EISDIR/ENOTDIR 로 실패.
    // open + writeFile 까지는 성공해 tmp 가 생성되지만, catch 블록이 정리해야 한다.
    const target = join(dir, 'isdir');
    await fs.mkdir(target);

    await expect(writeFileAtomic(target, 'data')).rejects.toThrow();

    // .tmp 잔존 없음 — 본 invariant 가 깨지면 후속 atomic 호출이 EEXIST 로 깨진다.
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });

  it('동시 쓰기 (Promise.all) 시 .tmp 잔존 없음 — atomicity 는 단일 caller 한정 (Quad-review W)', async () => {
    // io-atomic.ts 의 contract (모듈 상단 주석에 명시):
    //   "호출자는 같은 path 에 동시 호출하지 않도록 보장해야 한다 (mutateConfig 같은 직렬화 헬퍼 사용)."
    //
    // 즉 같은 target 에 대한 동시 호출은 결과 미정 — tmp path 가 결정적 (`${target}.tmp`) 이라
    // 호출 A 가 open(tmp) 성공 후 호출 B 가 open(tmp) EEXIST → B 의 catch 가 rm(tmp) → A 의
    // rename 이 ENOENT 로 실패. 결과적으로 두 호출 모두 실패 가능.
    //
    // 본 테스트는 그 한계 하에서도 깨지지 않아야 할 invariant 만 검증:
    //  1) 파일이 생성되었다면 그 값은 A/B/C 중 하나 (partial write 없음)
    //  2) .tmp 잔존 없음 — 후속 호출이 EEXIST 로 깨지지 않게 보장
    const target = join(dir, 'concurrent.json');
    await Promise.allSettled([
      writeFileAtomic(target, 'A'),
      writeFileAtomic(target, 'B'),
      writeFileAtomic(target, 'C')
    ]);

    const fileExists = await fs.access(target).then(() => true).catch(() => false);
    if (fileExists) {
      expect(['A', 'B', 'C']).toContain(await fs.readFile(target, 'utf8'));
    }
    const entries = await fs.readdir(dir);
    expect(entries.filter((e) => e.endsWith('.tmp'))).toEqual([]);
  });
});
