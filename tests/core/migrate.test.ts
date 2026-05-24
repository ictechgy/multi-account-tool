/**
 * migrate 단위 테스트.
 *
 * v0.1 (~/.multi-sub-terminal) → v0.2 (~/.multi-account-tool) rename 의 5 분기:
 *   1) 옛 디렉토리 없음 → no-op
 *   2) 옛 디렉토리만 있음 → rename 성공 + stderr 알림
 *   3) 둘 다 있음 → 충돌 경고 + no rename (사용자 수동 정리 안내)
 *   4) renameSync 가 Error throw → 경고 + 안내
 *   5) renameSync 가 non-Error (string 등) throw → String(err) 경로 검증
 *
 * setupTmpHome 으로 \$HOME 격리. legacyDataDir() 가 호출 시점 HOME 을 반영하므로
 * 정상 분기 describe 는 static import 로 단순화 가능 (Quad-review I).
 * rename 실패 describe 만 vi.doMock 패턴 + beforeEach 에서 vi.resetModules 명시.
 */

import { promises as fsPromises, existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { migrateLegacyDataDir } from '../../src/core/migrate.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('migrateLegacyDataDir — 정상 분기 (no-op / rename 성공 / 충돌)', () => {
  let tmp: TmpHome;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* 캡처 */ });
  });

  afterEach(async () => {
    errSpy.mockRestore();
    await tmp.cleanup();
  });

  it('옛 디렉토리 없음 → no-op (rename 안 함, stderr 침묵)', () => {
    migrateLegacyDataDir();
    expect(existsSync(join(tmp.home, '.multi-account-tool'))).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('옛 디렉토리만 있음 → 새 위치로 rename + stderr 안내', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fsPromises.mkdir(legacy, { recursive: true });
    await fsPromises.writeFile(join(legacy, 'marker.txt'), 'v0.1 data');

    migrateLegacyDataDir();

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(await fsPromises.readFile(join(current, 'marker.txt'), 'utf8')).toBe('v0.1 data');
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/마이그레이션 완료/));
  });

  it('옛 + 새 디렉토리 둘 다 있음 → 충돌 경고 + rename 안 함 (수동 정리 안내)', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fsPromises.mkdir(legacy, { recursive: true });
    await fsPromises.mkdir(current, { recursive: true });
    await fsPromises.writeFile(join(legacy, 'legacy.txt'), 'old');
    await fsPromises.writeFile(join(current, 'current.txt'), 'new');

    migrateLegacyDataDir();

    // 둘 다 그대로 보존 — 데이터 손실 방지.
    expect(existsSync(join(legacy, 'legacy.txt'))).toBe(true);
    expect(existsSync(join(current, 'current.txt'))).toBe(true);
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/둘 다 존재합니다/));
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/수동으로/));
  });
});

/**
 * rename 실패 분기 — vi.doMock 으로 node:fs 의 renameSync 만 throw 하게 격리.
 * beforeEach 에서 vi.resetModules() 먼저 호출 → 이후 doMock + dynamic import 순서가 명시적.
 * 다른 fs 함수 (existsSync 등) 는 importActual 로 real fs 유지.
 */
describe('migrateLegacyDataDir — rename 실패 시 빈 catch 아님 (에러 detail 노출)', () => {
  let tmp: TmpHome;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* 캡처 */ });
    // mock 등록 전 cache clear — doMock 효과가 dynamic import 에 정확히 적용되도록.
    vi.resetModules();
  });

  afterEach(async () => {
    errSpy.mockRestore();
    await tmp.cleanup();
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('renameSync 가 Error throw → 경고 + Error.message 노출', async () => {
    const renameMock = vi.fn(() => {
      throw new Error('EPERM: permission denied');
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, renameSync: renameMock };
    });

    const legacy = join(tmp.home, '.multi-sub-terminal');
    await fsPromises.mkdir(legacy, { recursive: true });

    const { migrateLegacyDataDir } = await import('../../src/core/migrate.js');
    migrateLegacyDataDir();

    // mock 이 실제로 적용됐는지 검증 (catch 분기에 진입 확인).
    expect(renameMock).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/마이그레이션 실패/));
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/EPERM/));
  });

  it('renameSync 가 non-Error (string) throw → String(err) 경로로 detail 노출', async () => {
    // migrate.ts:42 의 `err instanceof Error ? err.message : String(err)` 분기에서
    // String(err) 경로 검증 (Quad-review M).
    const renameMock = vi.fn(() => {
      throw 'raw-string-error-payload';
    });
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return { ...actual, renameSync: renameMock };
    });

    const legacy = join(tmp.home, '.multi-sub-terminal');
    await fsPromises.mkdir(legacy, { recursive: true });

    const { migrateLegacyDataDir } = await import('../../src/core/migrate.js');
    migrateLegacyDataDir();

    expect(renameMock).toHaveBeenCalledOnce();
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/raw-string-error-payload/));
  });
});
