/**
 * "새 계정으로 시작" (startsLoggedOut 프로필) 전환 테스트.
 *
 * sources.ts 만 mock 하고 라이브 상태를 saveAs → 값 Map 으로 흉내낸다 (write/remove 가 Map 을
 * 갱신). config / profile-store / cli-defs 는 real — setupTmpHome 의 $HOME 격리 하에서 실제 fs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/core/sources.js', () => ({
  readSource: vi.fn(),
  removeSource: vi.fn(),
  writeSource: vi.fn(),
  sourceExists: vi.fn()
}));

import { getActiveProfile, setActiveProfile } from '../../src/core/config.js';
import { createProfile, profileExists, readMeta, readProfileFile } from '../../src/core/profile-store.js';
import { readSource, removeSource, writeSource } from '../../src/core/sources.js';
import {
  snapshotLiveToProfile,
  switchProfile,
  switchToNewLoggedOutProfile,
  UnsavedLiveCredentialsError
} from '../../src/core/switcher.js';
import type { Source } from '../../src/core/types.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

const mockReadSource = vi.mocked(readSource);
const mockRemoveSource = vi.mocked(removeSource);
const mockWriteSource = vi.mocked(writeSource);

let live: Map<string, string>;

function useLive(initial: Record<string, string>): void {
  live = new Map(Object.entries(initial));
  mockReadSource.mockImplementation(async (src: Source) => live.get(src.saveAs) ?? null);
  mockWriteSource.mockImplementation(async (src: Source, value: string) => {
    live.set(src.saveAs, value);
  });
  mockRemoveSource.mockImplementation(async (src: Source) => {
    live.delete(src.saveAs);
  });
}

describe('switchToNewLoggedOutProfile', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await tmp.cleanup();
  });

  it('활성 프로필에 라이브를 저장한 뒤 라이브를 지우고 새 프로필을 활성화한다', async () => {
    useLive({ 'auth.json': 'work-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');

    const result = await switchToNewLoggedOutProfile('codex', 'fresh');

    expect(await readProfileFile('codex', 'work', 'auth.json')).toBe('work-token');
    expect(live.size).toBe(0);
    expect(await getActiveProfile('codex')).toBe('fresh');
    expect((await readMeta('codex', 'fresh'))?.startsLoggedOut).toBe(true);
    expect(result.fromSnapshot?.profileName).toBe('work');
    expect(result.restore).toMatchObject({ cleared: ['auth.json'], carriedOver: [], restored: [] });
  });

  it('여러 source 중 라이브에 있는 것만 지운다', async () => {
    useLive({ 'oauth_creds.json': 'g-token' });
    await createProfile('gemini', 'work');
    await setActiveProfile('gemini', 'work');

    const result = await switchToNewLoggedOutProfile('gemini', 'fresh');

    expect(result.restore.cleared).toEqual(['oauth_creds.json']);
    expect(mockRemoveSource).toHaveBeenCalledTimes(1);
  });

  it('활성 프로필이 없고 라이브가 남아 있으면 프로필을 만들기 전에 거부한다 (저장 안 된 로그인 보호)', async () => {
    useLive({ 'auth.json': 'unsaved-token' });

    await expect(switchToNewLoggedOutProfile('codex', 'fresh')).rejects.toBeInstanceOf(UnsavedLiveCredentialsError);

    expect(await profileExists('codex', 'fresh')).toBe(false);
    expect(live.get('auth.json')).toBe('unsaved-token');
    expect(mockRemoveSource).not.toHaveBeenCalled();
  });

  it('활성 프로필이 없어도 라이브가 비어 있으면 진행한다', async () => {
    useLive({});

    const result = await switchToNewLoggedOutProfile('codex', 'fresh');

    expect(result.restore.cleared).toEqual([]);
    expect(await getActiveProfile('codex')).toBe('fresh');
  });

  it('skipPreSwapSnapshot(폐기)이면 활성 프로필에 저장하지 않고 라이브를 지운다', async () => {
    useLive({ 'auth.json': 'rotated-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');

    const result = await switchToNewLoggedOutProfile('codex', 'fresh', { skipPreSwapSnapshot: true });

    expect(result.fromSnapshot).toBeUndefined();
    expect(await readProfileFile('codex', 'work', 'auth.json')).toBeNull();
    expect(live.size).toBe(0);
  });

  it('라이브 삭제가 실패하면 라이브를 되돌리고 방금 만든 빈 프로필을 지운다', async () => {
    useLive({ 'auth.json': 'work-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');
    mockRemoveSource.mockRejectedValueOnce(new Error('remove failed'));

    await expect(switchToNewLoggedOutProfile('codex', 'fresh')).rejects.toThrow('remove failed');

    expect(await profileExists('codex', 'fresh')).toBe(false);
    expect(await getActiveProfile('codex')).toBe('work');
    expect(live.get('auth.json')).toBe('work-token');
  });

  it('이미 있는 이름이면 거부하고 라이브를 건드리지 않는다', async () => {
    useLive({ 'auth.json': 'work-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');

    await expect(switchToNewLoggedOutProfile('codex', 'work')).rejects.toThrow(/이미 존재/);
    expect(live.get('auth.json')).toBe('work-token');
  });
});

describe('startsLoggedOut 프로필의 이후 전환', () => {
  let tmp: TmpHome;
  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
    vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await tmp.cleanup();
  });

  it('새 로그인이 캡처되면 일반 프로필이 되어 다음 전환에서 저장본을 복원한다', async () => {
    useLive({ 'auth.json': 'work-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');
    await switchToNewLoggedOutProfile('codex', 'fresh');

    // 사용자가 CLI 에서 새 계정으로 로그인 → work 로 전환하면 fresh 에 자동 저장된다.
    live.set('auth.json', 'fresh-token');
    await switchProfile('codex', 'work');
    expect(await readProfileFile('codex', 'fresh', 'auth.json')).toBe('fresh-token');
    expect((await readMeta('codex', 'fresh'))?.startsLoggedOut).toBeUndefined();
    expect(live.get('auth.json')).toBe('work-token');

    const back = await switchProfile('codex', 'fresh');
    expect(back.restore).toMatchObject({ restored: ['auth.json'], cleared: [] });
    expect(live.get('auth.json')).toBe('fresh-token');
  });

  it('로그인 없이 다른 프로필로 갔다가 돌아와도 여전히 로그아웃 상태로 전환된다', async () => {
    useLive({ 'auth.json': 'work-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');
    await switchToNewLoggedOutProfile('codex', 'fresh');

    await switchProfile('codex', 'work'); // 라이브가 비어 있어 fresh 에 캡처되는 것 없음
    expect((await readMeta('codex', 'fresh'))?.startsLoggedOut).toBe(true);

    const back = await switchProfile('codex', 'fresh');
    expect(back.restore.cleared).toEqual(['auth.json']);
    expect(live.size).toBe(0);
  });

  it('일반 switchProfile 도 활성 프로필 없이 저장 안 된 라이브를 지우지 않는다', async () => {
    useLive({});
    await createProfile('codex', 'fresh', undefined, { startsLoggedOut: true });
    live.set('auth.json', 'unsaved-token');

    await expect(switchProfile('codex', 'fresh')).rejects.toBeInstanceOf(UnsavedLiveCredentialsError);
    expect(live.get('auth.json')).toBe('unsaved-token');
  });

  it('startsLoggedOut 가 아닌 빈 프로필은 기존처럼 라이브를 이월한다 (회귀 가드)', async () => {
    useLive({ 'auth.json': 'work-token' });
    await createProfile('codex', 'work');
    await setActiveProfile('codex', 'work');
    await createProfile('codex', 'legacy-empty');

    const result = await switchProfile('codex', 'legacy-empty');

    expect(result.restore).toMatchObject({ cleared: [], carriedOver: ['auth.json'] });
    expect(live.get('auth.json')).toBe('work-token');
    expect(mockRemoveSource).not.toHaveBeenCalled();
  });

  it('snapshotLiveToProfile 로 직접 캡처해도 표시가 지워진다', async () => {
    useLive({});
    await switchToNewLoggedOutProfile('codex', 'fresh');
    live.set('auth.json', 'fresh-token');

    await snapshotLiveToProfile('codex', 'fresh');

    expect((await readMeta('codex', 'fresh'))?.startsLoggedOut).toBeUndefined();
  });
});
