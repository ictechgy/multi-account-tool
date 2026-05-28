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

// 'tri-cli' fake CliDef (3 sources) 주입 — switcher 의 reverse-order rollback 검증용.
// BUILTIN 에는 1~2 source CLI 만 있어 sequential 과 구분 안 됨 (line 196 한계 해결).
// vi.hoisted 로 factory 보다 먼저 평가되도록 보장.
const { TRI_CLI } = vi.hoisted(() => ({
  TRI_CLI: {
    id: 'tri-cli',
    name: 'Tri Source Test CLI',
    sources: [
      { type: 'file', path: '/tmp/mat-tri-a', saveAs: 'a.json' },
      { type: 'file', path: '/tmp/mat-tri-b', saveAs: 'b.json' },
      { type: 'file', path: '/tmp/mat-tri-c', saveAs: 'c.json' }
    ]
  }
}));

vi.mock('../../src/core/cli-defs.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/cli-defs.js')>();
  return {
    ...actual,
    // 'tri-cli' 만 fake 로 override, 나머지 ('codex' / 'gemini' 등) 는 real lookup 유지.
    findCliDef: (id: string) => (id === 'tri-cli' ? TRI_CLI : actual.findCliDef(id))
  };
});

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

      // reverse-order 자체 검증은 'tri-cli' 3-source 케이스가 담당 (아래 it 참조).
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

    it('rollback reverse-order (3-source tri-cli): 3rd source throw → b → a 역순으로 liveBackup 복원', async () => {
      // 2-source (gemini) 는 [1번 적용, 2번 throw, 1번 rollback] 으로 reverse 와 sequential 동치.
      // 3+ source 에서만 [a,b 적용, c throw, b rollback, a rollback] 순서가 reverse 임을 확인.
      await setupProfile('tri-cli', 'work');
      await writeProfileFile('tri-cli', 'work', 'a.json', 'stored-a');
      await writeProfileFile('tri-cli', 'work', 'b.json', 'stored-b');
      await writeProfileFile('tri-cli', 'work', 'c.json', 'stored-c');

      mockReadSource.mockImplementation(async (src: Source) => {
        const map: Record<string, string> = {
          'a.json': 'live-a',
          'b.json': 'live-b',
          'c.json': 'live-c'
        };
        return map[src.saveAs] ?? null;
      });

      mockWriteSource.mockImplementation(async (src: Source) => {
        if (src.saveAs === 'c.json') {
          throw new Error('3rd source write failed');
        }
      });

      await expect(restoreProfileToLive('tri-cli', 'work'))
        .rejects.toThrow('3rd source write failed');

      // 호출 순서:
      //  0. (a, 'stored-a') — apply 1
      //  1. (b, 'stored-b') — apply 2
      //  2. (c, 'stored-c') — apply 3 (throw)
      //  3. (b, 'live-b')   — rollback (appliedIdx.reverse() 의 첫 번째)
      //  4. (a, 'live-a')   — rollback (appliedIdx.reverse() 의 두 번째)
      const calls = mockWriteSource.mock.calls;
      expect(calls).toHaveLength(5);
      expect((calls[0][0] as Source).saveAs).toBe('a.json');
      expect(calls[0][1]).toBe('stored-a');
      expect((calls[1][0] as Source).saveAs).toBe('b.json');
      expect(calls[1][1]).toBe('stored-b');
      expect((calls[2][0] as Source).saveAs).toBe('c.json');
      expect(calls[2][1]).toBe('stored-c');
      // 핵심: reverse-order — b 먼저, 그다음 a (a 가 먼저 적용됐으므로 가장 마지막 rollback).
      expect((calls[3][0] as Source).saveAs).toBe('b.json');
      expect(calls[3][1]).toBe('live-b');
      expect((calls[4][0] as Source).saveAs).toBe('a.json');
      expect(calls[4][1]).toBe('live-a');
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

    it('current === toProfile: 무조건 no-op (snapshot + restore 모두 skip, writeSource 0회)', async () => {
      // quad-review HIGH fix (#2): current===toProfile 은 snapshot 만 skip 이 아니라
      // restore 까지 모두 skip 한다. 그렇지 않으면 라이브의 회전된 토큰이 stored 로
      // 덮어써져 데이터 손실 발생 (public API 의 contract gap).
      await setupProfile('codex', 'work');
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'value');
      mockReadSource.mockResolvedValue('live-rotated');
      mockWriteSource.mockResolvedValue(undefined);

      const result = await switchProfile('codex', 'work');

      expect(result.fromSnapshot).toBeUndefined();
      expect(result.restore.restored).toEqual([]);
      expect(result.restore.missing).toEqual([]);
      // writeSource 0회 — 라이브 회전 토큰 보존
      expect(mockWriteSource).not.toHaveBeenCalled();
      // active 동일 유지
      expect(await getActiveProfile('codex')).toBe('work');
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

  /**
   * PR-F* preSwapLiveFreshness — swap 직전 freshness 보고가 SwitchResult 에 포함된다.
   *
   * 정책 invariant:
   *  - active 가 있고 toProfile 과 다르면 inspectLiveFreshness 결과 포함
   *  - active 미설정 시 미포함
   *  - active === toProfile (no-op 흐름) 시 미포함
   *  - inspect 예외는 swallow — swap 자체는 진행, preSwapLiveFreshness 만 absent
   */
  describe('switchProfile — preSwapLiveFreshness (PR-F*)', () => {
    beforeEach(async () => {
      await setupProfile('codex', 'work');
      await setupProfile('codex', 'home');
      await writeProfileFile('codex', 'home', 'auth.json', 'home-stored');
      mockWriteSource.mockResolvedValue(undefined);
    });

    it('active 있음 + toProfile 다름 → preSwapLiveFreshness 보고', async () => {
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue('work-live-changed');  // live ≠ stored

      const result = await switchProfile('codex', 'home');
      expect(result.preSwapLiveFreshness).toBeDefined();
      expect(result.preSwapLiveFreshness?.cliId).toBe('codex');
      expect(result.preSwapLiveFreshness?.profileName).toBe('work');
      expect(result.preSwapLiveFreshness?.sources[0].saveAs).toBe('auth.json');
    });

    it('active 미설정 → preSwapLiveFreshness 미포함 (보고 불필요)', async () => {
      // active 미설정 상태에서 home 으로 swap
      mockReadSource.mockResolvedValue('any');
      const result = await switchProfile('codex', 'home');
      expect(result.preSwapLiveFreshness).toBeUndefined();
    });

    it('active === toProfile (no-op) → preSwapLiveFreshness 미포함', async () => {
      await setActiveProfile('codex', 'home');
      mockReadSource.mockResolvedValue('live');
      const result = await switchProfile('codex', 'home');
      expect(result.preSwapLiveFreshness).toBeUndefined();
    });

    it('inspectFreshness 예외 swallow → swap 정상 진행, freshness 만 absent', async () => {
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      // readSource 첫 호출 (snapshot — Snapshot 단계는 stored 캡처 위해 또 호출됨)
      // mockImplementationOnce 로 첫 호출만 throw, 그 뒤는 success
      mockReadSource
        .mockRejectedValueOnce(new Error('freshness read boom'))
        .mockResolvedValue('captured');

      // snapshot 단계가 readSource 를 또 부르므로 throw 가 snapshot 으로 전파될 위험.
      // safeInspectFreshness 는 readSource 의 첫 호출에서 잡혀야 한다 — swap 자체는 정상 동작.
      const result = await switchProfile('codex', 'home');
      // freshness 는 absent (예외 swallow)
      expect(result.preSwapLiveFreshness).toBeUndefined();
      // restore 는 정상 진행 — active 가 home 으로 갱신
      expect(await getActiveProfile('codex')).toBe('home');
    });
  });

  /**
   * PR-G — switchProfile.skipPreSwapSnapshot 옵션 (TUI 폐기 dialog path).
   *
   * 폐기 path 는 사용자가 "라이브 자격증명 (refresh-rotated 토큰) 을 의도적으로
   * 폐기" 한다고 명시 선택한 경우만 사용된다. 결과: snapshotLiveToProfile 호출 없음,
   * readSource(snapshot 용) 호출 없음, freshness inspect 도 미수행 (이미 사용자가
   * dialog 에서 확인했으므로 재보고 불필요), restore + setActive 만 수행.
   *
   * 회귀 위험: 옵션 부재 (기존 호출자) 는 기존 동작 (snapshot 수행) 그대로 — 본
   * describe 의 첫 테스트가 명시.
   */
  describe('switchProfile — skipPreSwapSnapshot (PR-G)', () => {
    beforeEach(async () => {
      await setupProfile('codex', 'work');
      await setupProfile('codex', 'home');
      await writeProfileFile('codex', 'home', 'auth.json', 'home-stored');
      mockWriteSource.mockResolvedValue(undefined);
    });

    it('옵션 미지정 (기존 호출자) → snapshot 수행 + preSwapLiveFreshness 보고', async () => {
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue('work-live');

      const result = await switchProfile('codex', 'home');
      expect(result.fromSnapshot).toBeDefined();
      expect(result.fromSnapshot?.captured).toEqual(['auth.json']);
      // freshness 는 swap 직전 1회 보고
      expect(result.preSwapLiveFreshness).toBeDefined();
    });

    it('skipPreSwapSnapshot=true → snapshot 미수행 + freshness 보고 부재', async () => {
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue('work-live-rotated');

      const result = await switchProfile('codex', 'home', { skipPreSwapSnapshot: true });
      // 폐기 — snapshot 결과 없음
      expect(result.fromSnapshot).toBeUndefined();
      // 사용자가 이미 dialog 에서 확인했으므로 재보고 불필요
      expect(result.preSwapLiveFreshness).toBeUndefined();
      // restore + setActive 는 정상 수행
      expect(result.restore.restored).toEqual(['auth.json']);
      expect(await getActiveProfile('codex')).toBe('home');
      // 라이브 자격증명은 home 의 저장본으로 덮어써짐 (writeSource 1회 호출 = restore)
      expect(mockWriteSource).toHaveBeenCalledTimes(1);
    });

    it('skipPreSwapSnapshot=false → 기본 동작과 동일 (snapshot 수행)', async () => {
      // 명시 false 는 undefined 와 동등 — 안전한 backward-compat.
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue('work-live');

      const result = await switchProfile('codex', 'home', { skipPreSwapSnapshot: false });
      expect(result.fromSnapshot).toBeDefined();
      expect(result.fromSnapshot?.captured).toEqual(['auth.json']);
    });

    it('skipPreSwapSnapshot=true 는 snapshot 의 readSource 2회 (freshness+snapshot) 를 생략', async () => {
      // 폐기 path 의 핵심 invariant — snapshot 단계 readSource (freshness inspect 1회
      // + snapshotLiveToProfile 1회 = 2회) 가 생략된다. restore 단계의 collectRestorePlan
      // 은 rollback 용 liveBackup 캡처로 readSource 를 호출하므로 1회는 유지.
      // 비교를 위해 두 호출 시나리오를 같은 테스트에서 측정.
      await setActiveProfile('codex', 'work');
      await writeProfileFile('codex', 'work', 'auth.json', 'work-stored');
      mockReadSource.mockResolvedValue('any');

      // baseline: 기존 동작 (snapshot 수행) — 3회 호출 (freshness + snapshot + liveBackup)
      await switchProfile('codex', 'home');
      const baselineCalls = mockReadSource.mock.calls.length;
      expect(baselineCalls).toBe(3);

      // reset + 폐기 path
      mockReadSource.mockClear();
      await setActiveProfile('codex', 'work');  // home 으로 갔던 active 되돌리기
      await switchProfile('codex', 'home', { skipPreSwapSnapshot: true });
      // 폐기 — restore 의 liveBackup 1회만 남음 (snapshot/freshness 2회 생략)
      expect(mockReadSource.mock.calls.length).toBe(1);
    });

    it('skipPreSwapSnapshot=true + active === toProfile → 무조건 no-op (writeSource 0회)', async () => {
      // quad-review HIGH fix (#2): skipPreSwapSnapshot 무관 — current===toProfile
      // 은 라이브 회전 토큰을 stored 로 덮어쓰는 데이터 손실 위험이 있어 무조건
      // skip. 호출자가 명시 폐기를 선택해도 동일한 두 프로필 사이엔 의미 없음.
      await setActiveProfile('codex', 'home');
      mockReadSource.mockResolvedValue('live-rotated');

      const result = await switchProfile('codex', 'home', { skipPreSwapSnapshot: true });
      expect(result.fromSnapshot).toBeUndefined();
      expect(result.preSwapLiveFreshness).toBeUndefined();
      expect(result.restore.restored).toEqual([]);
      // 라이브 자격증명 보존 — writeSource 호출 안 됨
      expect(mockWriteSource).not.toHaveBeenCalled();
      expect(await getActiveProfile('codex')).toBe('home');
    });

    it('active 미설정 + skipPreSwapSnapshot=true → 단순 restore (snapshot 불가능)', async () => {
      mockReadSource.mockResolvedValue('any');
      const result = await switchProfile('codex', 'home', { skipPreSwapSnapshot: true });
      expect(result.fromSnapshot).toBeUndefined();
      expect(result.restore.restored).toEqual(['auth.json']);
      expect(await getActiveProfile('codex')).toBe('home');
    });
  });
});
