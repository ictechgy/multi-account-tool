/**
 * switcher 단위 테스트.
 *
 * 3 함수 (snapshotLiveToProfile / restoreProfileToLive / switchProfile) 의
 * happy-path + 부분 실패 롤백 + 좀비 프로필 가드 등 핵심 invariant 검증.
 *
 * Mock 전략: sources.ts (readSource/writeSource) 만 vi.mock 으로 격리.
 * config / profile-store / cli-defs 는 real (setupTmpHome 의 \$HOME 격리 하에서
 * 실제 fs 통합) — switcher 의 cross-module 동작이 가장 자주 깨지는 지점이므로
 * 가능한 한 real implementation 으로 검증.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/sources.js', () => ({
  readSource: vi.fn(),
  writeSource: vi.fn(),
  sourceExists: vi.fn()
}));

import { getActiveProfile, setActiveProfile } from '../../src/core/config.js';
import { createProfile, profileExists, readProfileFile } from '../../src/core/profile-store.js';
import { readSource, writeSource } from '../../src/core/sources.js';
import {
  restoreProfileToLive,
  snapshotLiveToProfile,
  switchProfile
} from '../../src/core/switcher.js';
import type { Source } from '../../src/core/types.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const mockReadSource = vi.mocked(readSource);
const mockWriteSource = vi.mocked(writeSource);

/** codex (1 source) 시나리오 빠른 setup. */
async function setupCodex(): Promise<void> {
  await createProfile('codex', 'work');
}

/** gemini (2 source) 시나리오 빠른 setup. */
async function setupGemini(profileName: string): Promise<void> {
  await createProfile('gemini', profileName);
}

describe('switcher', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    vi.clearAllMocks();
    await tmp.cleanup();
  });

  describe('snapshotLiveToProfile', () => {
    it('모든 라이브 source 캡처 → captured 채워짐, profile 자동 생성', async () => {
      mockReadSource.mockResolvedValue('live-data');

      const result = await snapshotLiveToProfile('codex', 'work');

      expect(result.cliId).toBe('codex');
      expect(result.profileName).toBe('work');
      expect(result.captured).toEqual(['auth.json']);  // codex 의 1 source
      expect(result.empty).toEqual([]);
      // profile 자동 생성 검증
      expect(await profileExists('codex', 'work')).toBe(true);
      // 디스크 저장 검증 (real fs)
      expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('live-data');
    });

    it('라이브 값 없는 source 는 empty 에 (writeSource 호출 안 됨)', async () => {
      mockReadSource.mockResolvedValue(null);

      const result = await snapshotLiveToProfile('codex', 'no-live');

      expect(result.captured).toEqual([]);
      expect(result.empty).toEqual(['auth.json']);
      expect(await readProfileFile('codex', 'no-live', 'auth.json')).toBeNull();
    });

    it('gemini (multi-source) partial: 한 source 만 live → captured/empty 분리', async () => {
      mockReadSource.mockImplementation(async (src: Source) =>
        src.saveAs === 'oauth_creds.json' ? 'oauth-data' : null
      );

      const result = await snapshotLiveToProfile('gemini', 'partial');

      expect(result.captured).toEqual(['oauth_creds.json']);
      expect(result.empty).toEqual(['google_accounts.json']);
      expect(await readProfileFile('gemini', 'partial', 'oauth_creds.json')).toBe('oauth-data');
      expect(await readProfileFile('gemini', 'partial', 'google_accounts.json')).toBeNull();
    });

    it('알 수 없는 cli → throw', async () => {
      await expect(snapshotLiveToProfile('unknown-cli', 'p')).rejects.toThrow(/알 수 없는 CLI/);
    });
  });

  describe('restoreProfileToLive', () => {
    it('프로필 없음 → throw, writeSource 호출 안 됨', async () => {
      await expect(restoreProfileToLive('codex', 'never-existed'))
        .rejects.toThrow(/프로필을 찾을 수 없습니다/);
      expect(mockWriteSource).not.toHaveBeenCalled();
    });

    it('모든 source 복원 → restored, liveBackup 도 미리 수집', async () => {
      await setupCodex();
      await import('../../src/core/profile-store.js')
        .then((m) => m.writeProfileFile('codex', 'work', 'auth.json', 'stored-value'));
      mockReadSource.mockResolvedValue('current-live');  // liveBackup 준비
      mockWriteSource.mockResolvedValue(undefined);

      const result = await restoreProfileToLive('codex', 'work');

      expect(result.restored).toEqual(['auth.json']);
      expect(result.missing).toEqual([]);
      expect(mockWriteSource).toHaveBeenCalledWith(
        expect.objectContaining({ saveAs: 'auth.json' }),
        'stored-value'
      );
    });

    it('일부 source 의 stored 없음 → missing 에 (writeSource 호출 안 함)', async () => {
      await setupGemini('only-oauth');
      const ps = await import('../../src/core/profile-store.js');
      // oauth_creds.json 만 저장, google_accounts.json 없음
      await ps.writeProfileFile('gemini', 'only-oauth', 'oauth_creds.json', 'oauth-stored');
      mockReadSource.mockResolvedValue('current-live');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await restoreProfileToLive('gemini', 'only-oauth');

      expect(result.restored).toEqual(['oauth_creds.json']);
      expect(result.missing).toEqual(['google_accounts.json']);
      expect(mockWriteSource).toHaveBeenCalledOnce();  // oauth 만
    });

    it('부분 실패 시 롤백: 두 번째 source writeSource throw → 첫 source liveBackup 으로 원복 + 원본 에러 throw', async () => {
      await setupGemini('rollback-test');
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('gemini', 'rollback-test', 'oauth_creds.json', 'new-oauth');
      await ps.writeProfileFile('gemini', 'rollback-test', 'google_accounts.json', 'new-accounts');

      // liveBackup: 현재 라이브 값 (롤백 시 복원될 값)
      mockReadSource.mockImplementation(async (src: Source) =>
        src.saveAs === 'oauth_creds.json' ? 'old-oauth-live' : 'old-accounts-live'
      );

      // writeSource: oauth 성공, google_accounts 실패
      mockWriteSource.mockImplementation(async (src: Source) => {
        if (src.saveAs === 'google_accounts.json') {
          throw new Error('write failed at google_accounts');
        }
      });

      await expect(restoreProfileToLive('gemini', 'rollback-test'))
        .rejects.toThrow('write failed at google_accounts');

      // 롤백: oauth 가 liveBackup ('old-oauth-live') 으로 다시 writeSource 호출되어야 함
      const oauthCalls = mockWriteSource.mock.calls.filter(
        (c) => (c[0] as Source).saveAs === 'oauth_creds.json'
      );
      expect(oauthCalls).toHaveLength(2);   // 1. 새 값 적용, 2. liveBackup 으로 롤백
      expect(oauthCalls[0][1]).toBe('new-oauth');
      expect(oauthCalls[1][1]).toBe('old-oauth-live');
    });

    it('롤백 시 liveBackup 이 null 인 source 는 skip (best-effort)', async () => {
      await setupGemini('null-backup');
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('gemini', 'null-backup', 'oauth_creds.json', 'new-oauth');
      await ps.writeProfileFile('gemini', 'null-backup', 'google_accounts.json', 'new-accounts');

      // 라이브 값 없음 (liveBackup = null)
      mockReadSource.mockResolvedValue(null);
      mockWriteSource.mockImplementation(async (src: Source) => {
        if (src.saveAs === 'google_accounts.json') {
          throw new Error('write failed');
        }
      });

      await expect(restoreProfileToLive('gemini', 'null-backup')).rejects.toThrow();

      // oauth 에 대한 writeSource 호출은 1번만 (롤백은 liveBackup null 이라 skip)
      const oauthCalls = mockWriteSource.mock.calls.filter(
        (c) => (c[0] as Source).saveAs === 'oauth_creds.json'
      );
      expect(oauthCalls).toHaveLength(1);
    });
  });

  describe('switchProfile', () => {
    it('정상: current 가 있고 다른 toProfile → snapshot + restore + setActive + touch', async () => {
      await setupCodex();
      await createProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('codex', 'home', 'auth.json', 'home-stored');

      mockReadSource.mockResolvedValue('live-from-work');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'home');

      // 1) snapshot 수행됨 (work 로 캡처)
      expect(result.fromSnapshot).toBeDefined();
      expect(result.fromSnapshot?.profileName).toBe('work');
      expect(result.fromSnapshot?.captured).toContain('auth.json');
      // 2) restore 수행됨 (home 의 stored 가 live 로)
      expect(result.restore.restored).toContain('auth.json');
      // 3) active 갱신
      expect(await getActiveProfile('codex')).toBe('home');
    });

    it('current 없음: snapshot skip, restore 만', async () => {
      await setupCodex();
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue(null);  // 라이브 없음 (snapshot 안 일어남)
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'work');

      expect(result.fromSnapshot).toBeUndefined();
      expect(result.restore.restored).toContain('auth.json');
      expect(await getActiveProfile('codex')).toBe('work');
    });

    it('current === toProfile: snapshot skip (자기 자신으로 swap 방지)', async () => {
      await setupCodex();
      await setActiveProfile('codex', 'work');
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('codex', 'work', 'auth.json', 'value');
      mockReadSource.mockResolvedValue(null);
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'work');

      expect(result.fromSnapshot).toBeUndefined();  // current === toProfile 이라 snapshot skip
    });

    it('current 프로필 디렉토리 외부 삭제 (좀비) → snapshot skip, restore 만 진행', async () => {
      await setupCodex();
      await createProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('codex', 'home', 'auth.json', 'home-stored');
      // 외부에서 work 디렉토리 삭제 (좀비 active)
      await ps.deleteProfile('codex', 'work');

      mockReadSource.mockResolvedValue('live');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'home');

      // 좀비 가드: snapshot skip (work 가 없으므로 auto-create 안 함)
      expect(result.fromSnapshot).toBeUndefined();
      expect(await profileExists('codex', 'work')).toBe(false);  // 부활 안 함
      expect(await getActiveProfile('codex')).toBe('home');
    });

    it('restore 실패: throw, setActive/touch 호출 안 됨, 활성 포인터 보존', async () => {
      await setupCodex();
      await createProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      // home 의 stored 가 있어야 restore 시도되고 writeSource 가 throw 함
      const ps = await import('../../src/core/profile-store.js');
      await ps.writeProfileFile('codex', 'home', 'auth.json', 'home-stored');

      mockReadSource.mockResolvedValue('live');
      mockWriteSource.mockRejectedValue(new Error('keychain locked'));

      await expect(switchProfile('codex', 'home')).rejects.toThrow('keychain locked');

      // active 가 work 그대로 (home 으로 안 바뀜)
      expect(await getActiveProfile('codex')).toBe('work');
    });

    it('알 수 없는 cli → throw', async () => {
      await expect(switchProfile('unknown-cli', 'p')).rejects.toThrow(/알 수 없는 CLI/);
    });
  });
});
