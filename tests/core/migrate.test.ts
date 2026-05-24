/**
 * migrate 단위 테스트.
 *
 * v0.1 (~/.multi-sub-terminal) → v0.2 (~/.multi-account-tool) rename 의 4 분기:
 *   1) 옛 디렉토리 없음 → no-op
 *   2) 옛 디렉토리만 있음 → rename 성공 + stderr 알림
 *   3) 둘 다 있음 → 충돌 경고 + no rename (사용자 수동 정리 안내)
 *   4) rename 실패 (권한 등) → 경고 + 안내
 *
 * setupTmpHome 으로 $HOME 격리. (3)/(4) 시나리오는 setupTmpHome 의 HOME 이
 * 적용된 후 migrate 가 호출되어야 하므로, migrate.ts 가 legacyDataDir() 함수로
 * 호출 시점의 HOME 을 반영하도록 되어 있다 (module-level constant 아님).
 *
 * rename 실패 케이스는 ESM 에서 fs 의 export 를 spyOn 할 수 없어 별도 describe
 * 에 두고 vi.mock('node:fs') 의 partial mock 패턴으로 검증.
 */

import { promises as fsPromises, existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    vi.resetModules();
  });

  it('옛 디렉토리 없음 → no-op (rename 안 함, stderr 침묵)', async () => {
    const { migrateLegacyDataDir } = await import('../../src/core/migrate.js');
    migrateLegacyDataDir();
    expect(existsSync(join(tmp.home, '.multi-account-tool'))).toBe(false);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('옛 디렉토리만 있음 → 새 위치로 rename + stderr 안내', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fsPromises.mkdir(legacy, { recursive: true });
    await fsPromises.writeFile(join(legacy, 'marker.txt'), 'v0.1 data');

    const { migrateLegacyDataDir } = await import('../../src/core/migrate.js');
    migrateLegacyDataDir();

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(await fsPromises.readFile(join(current, 'marker.txt'), 'utf8')).toBe('v0.1 data');
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toMatch(/마이그레이션 완료/);
  });

  it('옛 + 새 디렉토리 둘 다 있음 → 충돌 경고 + rename 안 함 (수동 정리 안내)', async () => {
    const legacy = join(tmp.home, '.multi-sub-terminal');
    const current = join(tmp.home, '.multi-account-tool');
    await fsPromises.mkdir(legacy, { recursive: true });
    await fsPromises.mkdir(current, { recursive: true });
    await fsPromises.writeFile(join(legacy, 'legacy.txt'), 'old');
    await fsPromises.writeFile(join(current, 'current.txt'), 'new');

    const { migrateLegacyDataDir } = await import('../../src/core/migrate.js');
    migrateLegacyDataDir();

    // 둘 다 그대로 보존 — 데이터 손실 방지.
    expect(existsSync(join(legacy, 'legacy.txt'))).toBe(true);
    expect(existsSync(join(current, 'current.txt'))).toBe(true);
    expect(errSpy).toHaveBeenCalledOnce();
    expect(errSpy.mock.calls[0][0]).toMatch(/둘 다 존재합니다/);
    expect(errSpy.mock.calls[0][0]).toMatch(/수동으로/);
  });
});

// rename 실패 케이스는 vi.mock 으로 node:fs.renameSync 만 throw 하도록 격리.
// 다른 fs 함수 (existsSync) 는 real fs 유지 (partial mock via importActual).
describe('migrateLegacyDataDir — rename 실패 시 빈 catch 아님 (에러 메시지 노출)', () => {
  let tmp: TmpHome;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* 캡처 */ });
  });

  afterEach(async () => {
    errSpy.mockRestore();
    await tmp.cleanup();
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('renameSync 가 throw → 경고 + 에러 detail 노출', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        renameSync: vi.fn(() => {
          throw new Error('EPERM: permission denied');
        })
      };
    });

    const legacy = join(tmp.home, '.multi-sub-terminal');
    await fsPromises.mkdir(legacy, { recursive: true });

    const { migrateLegacyDataDir } = await import('../../src/core/migrate.js');
    migrateLegacyDataDir();

    expect(errSpy).toHaveBeenCalledOnce();
    const msg = errSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/마이그레이션 실패/);
    expect(msg).toMatch(/EPERM/);
  });
});
