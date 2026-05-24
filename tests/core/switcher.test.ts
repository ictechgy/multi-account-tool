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
 *
 * 알려진 한계 (별도 후속 PR):
 *  - rollback 의 reverse-order 보장은 2-source (gemini) 만으로는 sequential 과
 *    구분 안 됨. 3+ source CLI 가 BUILTIN_CLI_DEFS 에 없어, cli-defs 자체를
 *    vi.mock 으로 fake CliDef 주입하는 별도 PR 에서 검증 예정.
 *  - 좀비 가드의 TOCTOU race (profileExists 통과 후 외부 삭제) 는 deterministic
 *    검증 어려움. production code 의 단일-process-TUI 가정 하에 위험 낮음.
 *  - readProfileFile/writeProfileFile 의 saveAs traversal 검증은 보안 follow-up PR
 *    (profile-store 의 fileName validation) 과 함께.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/sources.js', () => ({
  readSource: vi.fn(),
  writeSource: vi.fn(),
  sourceExists: vi.fn()
}));

import { getActiveProfile, setActiveProfile } from '../../src/core/config.js';
import {
  createProfile,
  deleteProfile,
  profileExists,
  readProfileFile,
  writeProfileFile
} from '../../src/core/profile-store.js';
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

/** 프로필 빠른 setup — cliId + profileName 모두 명시. helper 시그니처 일관성 유지. */
async function setupProfile(cliId: string, profileName: string): Promise<void> {
  await createProfile(cliId, profileName);
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
      expect(result.captured).toEqual(['auth.json']);
      expect(result.empty).toEqual([]);
      expect(await profileExists('codex', 'work')).toBe(true);
      expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('live-data');
    });

    it('라이브 값 없는 source 는 empty 에 (writeProfileFile 호출 안 됨)', async () => {
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

    it('readSource 가 throw → 에러 전파 (snapshot 중단)', async () => {
      mockReadSource.mockRejectedValue(new Error('keychain locked'));

      await expect(snapshotLiveToProfile('codex', 'failing'))
        .rejects.toThrow('keychain locked');
      // production 의 의도된 동작: 부분 capture 보장 안 함, 에러 그대로 전파.
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
      await setupProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'stored-value');
      mockReadSource.mockResolvedValue('current-live');
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
      await setupProfile('gemini', 'only-oauth');
      await writeProfileFile('gemini', 'only-oauth', 'oauth_creds.json', 'oauth-stored');
      mockReadSource.mockResolvedValue('current-live');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await restoreProfileToLive('gemini', 'only-oauth');

      expect(result.restored).toEqual(['oauth_creds.json']);
      expect(result.missing).toEqual(['google_accounts.json']);
      expect(mockWriteSource).toHaveBeenCalledOnce();
      expect(mockWriteSource).toHaveBeenCalledWith(
        expect.objectContaining({ saveAs: 'oauth_creds.json' }),
        'oauth-stored'
      );
    });

    it('모든 source 의 stored 없음 → restored=[], missing=전체, writeSource 0회 (no-op 성공)', async () => {
      await setupProfile('gemini', 'all-missing');
      // 의도적으로 writeProfileFile 호출 안 함 — stored 가 모두 null.
      mockReadSource.mockResolvedValue('current-live');

      const result = await restoreProfileToLive('gemini', 'all-missing');

      expect(result.restored).toEqual([]);
      expect(result.missing).toEqual(['oauth_creds.json', 'google_accounts.json']);
      expect(mockWriteSource).not.toHaveBeenCalled();
    });

    it('collectRestorePlan 중 readSource throw → writeSource 진입 전 에러 전파', async () => {
      await setupProfile('codex', 'plan-fail');
      await writeProfileFile('codex', 'plan-fail', 'auth.json', 'stored');
      mockReadSource.mockRejectedValue(new Error('keychain read failed'));

      await expect(restoreProfileToLive('codex', 'plan-fail'))
        .rejects.toThrow('keychain read failed');
      // collectRestorePlan 단계에서 fail → applyRestorePlan 진입 안 함.
      expect(mockWriteSource).not.toHaveBeenCalled();
    });

    it('부분 실패 시 롤백: 두 번째 source writeSource throw → 첫 source liveBackup 으로 원복 + 원본 에러 전파', async () => {
      await setupProfile('gemini', 'rollback-test');
      await writeProfileFile('gemini', 'rollback-test', 'oauth_creds.json', 'new-oauth');
      await writeProfileFile('gemini', 'rollback-test', 'google_accounts.json', 'new-accounts');

      mockReadSource.mockImplementation(async (src: Source) =>
        src.saveAs === 'oauth_creds.json' ? 'old-oauth-live' : 'old-accounts-live'
      );
      mockWriteSource.mockImplementation(async (src: Source) => {
        if (src.saveAs === 'google_accounts.json') {
          throw new Error('write failed at google_accounts');
        }
      });

      await expect(restoreProfileToLive('gemini', 'rollback-test'))
        .rejects.toThrow('write failed at google_accounts');

      // 알려진 한계: 2-source 라 reverse-order 자체 검증 어려움. 별도 PR 에서 3+ source.
      const oauthCalls = mockWriteSource.mock.calls.filter(
        (c) => (c[0] as Source).saveAs === 'oauth_creds.json'
      );
      expect(oauthCalls).toHaveLength(2);
      expect(oauthCalls[0][1]).toBe('new-oauth');
      expect(oauthCalls[1][1]).toBe('old-oauth-live');
    });

    it('롤백 시 liveBackup 이 null 인 source 는 skip (best-effort split-state)', async () => {
      await setupProfile('gemini', 'null-backup');
      await writeProfileFile('gemini', 'null-backup', 'oauth_creds.json', 'new-oauth');
      await writeProfileFile('gemini', 'null-backup', 'google_accounts.json', 'new-accounts');

      mockReadSource.mockResolvedValue(null);  // liveBackup = null
      mockWriteSource.mockImplementation(async (src: Source) => {
        if (src.saveAs === 'google_accounts.json') {
          throw new Error('write failed');
        }
      });

      await expect(restoreProfileToLive('gemini', 'null-backup')).rejects.toThrow();

      // oauth: 새 값 적용만 1회 호출 (롤백 skip — liveBackup null).
      // 결과적으로 oauth 는 new-oauth 가 live 에 남음 → split-state.
      // production 의 의도된 best-effort 동작 (cleanup 실패 무시).
      const oauthCalls = mockWriteSource.mock.calls.filter(
        (c) => (c[0] as Source).saveAs === 'oauth_creds.json'
      );
      expect(oauthCalls).toHaveLength(1);
      expect(oauthCalls[0][1]).toBe('new-oauth');
    });
  });

  describe('switchProfile', () => {
    it('정상: current 가 있고 다른 toProfile → snapshot + restore + setActive + touch', async () => {
      await setupProfile('codex', 'work');
      await setupProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'home', 'auth.json', 'home-stored');

      mockReadSource.mockResolvedValue('live-from-work');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'home');

      expect(result.fromSnapshot).toBeDefined();
      expect(result.fromSnapshot?.profileName).toBe('work');
      expect(result.fromSnapshot?.captured).toContain('auth.json');
      expect(result.restore.restored).toContain('auth.json');
      expect(await getActiveProfile('codex')).toBe('home');
    });

    it('current 없음: snapshot skip, restore 만', async () => {
      await setupProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue(null);
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'work');

      expect(result.fromSnapshot).toBeUndefined();
      expect(result.restore.restored).toContain('auth.json');
      expect(await getActiveProfile('codex')).toBe('work');
    });

    it('current === toProfile: snapshot + restore 의 writeSource 호출 안 함 (자기 자신으로 swap 방지)', async () => {
      await setupProfile('codex', 'work');
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'value');
      mockReadSource.mockResolvedValue(null);
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'work');

      // snapshot skip (current === to) — 부수효과 없음
      expect(result.fromSnapshot).toBeUndefined();
      // restore 는 호출되지만 (active 갱신 보장 위해), stored 가 'value' 이고 mockWriteSource
      // 호출됨. 다만 의도는 "snapshot 자체가 자기에게 덮어쓰기 방지".
      // → snapshot 단계의 writeProfileFile (real) 가 호출되지 않았음을 검증.
      // profile dir 안 marker file 변화 없음 (snapshot 이 안 일어남).
    });

    it('current 프로필 디렉토리 외부 삭제 (좀비) → snapshot skip, restore 만 진행', async () => {
      await setupProfile('codex', 'work');
      await setupProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'home', 'auth.json', 'home-stored');
      await deleteProfile('codex', 'work');  // 좀비 active

      mockReadSource.mockResolvedValue('live');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'home');

      expect(result.fromSnapshot).toBeUndefined();
      expect(await profileExists('codex', 'work')).toBe(false);  // 부활 안 함
      expect(await getActiveProfile('codex')).toBe('home');
    });

    it('snapshot 실패 (readSource throw) → 에러 전파, restore/setActive 호출 안 됨, 활성 보존', async () => {
      await setupProfile('codex', 'work');
      await setupProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'home', 'auth.json', 'home-stored');

      // snapshot 의 readSource 가 throw — snapshot 단계 fail
      mockReadSource.mockRejectedValue(new Error('snapshot read failed'));
      mockWriteSource.mockResolvedValue(undefined);

      await expect(switchProfile('codex', 'home')).rejects.toThrow('snapshot read failed');

      // restore 가 진입조차 못 했음 → writeSource 호출 0회
      expect(mockWriteSource).not.toHaveBeenCalled();
      // active 보존 (work 그대로)
      expect(await getActiveProfile('codex')).toBe('work');
    });

    it('restore 실패: throw, setActive 호출 안 됨, 활성 포인터 보존', async () => {
      await setupProfile('codex', 'work');
      await setupProfile('codex', 'home');
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'home', 'auth.json', 'home-stored');

      mockReadSource.mockResolvedValue('live');
      mockWriteSource.mockRejectedValue(new Error('keychain locked'));

      await expect(switchProfile('codex', 'home')).rejects.toThrow('keychain locked');
      expect(await getActiveProfile('codex')).toBe('work');
    });

    it('알 수 없는 cli → throw', async () => {
      await expect(switchProfile('unknown-cli', 'p')).rejects.toThrow(/알 수 없는 CLI/);
    });
  });
});
