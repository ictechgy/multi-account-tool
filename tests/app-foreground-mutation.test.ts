import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/core/sources.js', () => ({
  readSource: vi.fn(),
  writeSource: vi.fn(),
  sourceExists: vi.fn()
}));

import { __testHooks } from '../src/app.js';
import { findCliDef } from '../src/core/cli-defs.js';
import { getActiveProfile, setActiveProfile } from '../src/core/config.js';
import {
  createProfile,
  profileExists,
  readProfileFile,
  writeProfileFile
} from '../src/core/profile-store.js';
import { readSource } from '../src/core/sources.js';
import { setupTmpHome, type TmpHome } from './helpers/tmp-home.js';

const mockReadSource = vi.mocked(readSource);

function dispatchRecorder() {
  const actions: unknown[] = [];
  return {
    actions,
    dispatch: (action: unknown) => {
      actions.push(action);
    }
  };
}

function lastAction(actions: unknown[]): any {
  return actions.at(-1);
}

describe('TUI foreground mutation stale-active guards', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
    vi.clearAllMocks();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await tmp.cleanup();
  });

  it('formats ambient warnings into switch confirmation helpers without env values', async () => {
    const oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret-value-must-not-appear';

    try {
      const body = await __testHooks.switchConfirmBodyWithAmbient('codex', 'default', 'work');
      const block = await __testHooks.ambientWarningBlock('codex');

      expect(body).toMatch(/OPENAI_API_KEY/);
      expect(body).toMatch(/mat support codex/);
      expect(block).toMatch(/OPENAI_API_KEY/);
      expect(`${body}\n${block}`).not.toContain('sk-secret-value-must-not-appear');
    } finally {
      if (oldOpenAi == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAi;
    }
  });

  it('routes already-active switches through the ambient-aware confirmation body', async () => {
    const cli = findCliDef('codex');
    expect(cli).toBeDefined();
    const oldOpenAi = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'sk-secret-value-must-not-appear';

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    try {
      __testHooks.onSwitchAction(cli!, 'target', 'target', {} as any, dispatch as any, refresh);
      await new Promise((resolve) => setImmediate(resolve));

      const action = lastAction(actions);
      expect(action).toMatchObject({
        type: 'push',
        screen: {
          kind: 'confirm',
          title: `${cli!.name} 프로필 전환`
        }
      });
      expect(action.screen.body).toMatch(/target\s+→\s+target/);
      expect(action.screen.body).toMatch(/OPENAI_API_KEY/);
      expect(action.screen.body).toMatch(/mat support codex/);
      expect(action.screen.body).not.toContain('sk-secret-value-must-not-appear');
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      if (oldOpenAi == null) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = oldOpenAi;
    }
  });

  it('cancels delete when active changes to the target after confirmation was shown', async () => {
    await createProfile('codex', 'safe');
    await createProfile('codex', 'target');
    await setActiveProfile('codex', 'safe');

    // Simulate another foreground mutation while the delete confirm dialog is open.
    await setActiveProfile('codex', 'target');

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    await __testHooks.doDelete('codex', 'target', 'safe', dispatch as any, refresh);

    expect(await profileExists('codex', 'target')).toBe(true);
    expect(await getActiveProfile('codex')).toBe('target');
    expect(refresh).not.toHaveBeenCalled();
    expect(lastAction(actions)).toMatchObject({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '활성 프로필 변경 감지 — 작업 취소'
      }
    });
  });

  it('cancels capture when active changes after the overwrite warning was shown', async () => {
    await createProfile('codex', 'source');
    await createProfile('codex', 'target');
    await createProfile('codex', 'hijacker');
    await writeProfileFile('codex', 'target', 'auth.json', 'stored-target');
    await setActiveProfile('codex', 'source');

    // Simulate another foreground mutation while the capture warning dialog is open.
    await setActiveProfile('codex', 'hijacker');
    mockReadSource.mockResolvedValue('live-hijacker');

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    await __testHooks.doCapture('codex', 'target', 'source', dispatch as any, refresh);

    expect(mockReadSource).not.toHaveBeenCalled();
    expect(await readProfileFile('codex', 'target', 'auth.json')).toBe('stored-target');
    expect(refresh).not.toHaveBeenCalled();
    expect(lastAction(actions)).toMatchObject({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '활성 프로필 변경 감지 — 작업 취소'
      }
    });
  });

  it('cancels direct create when active was absent at render time but appears before mutation', async () => {
    const cli = findCliDef('codex');
    expect(cli).toBeDefined();
    await createProfile('codex', 'new-active');

    // Simulate active being assigned after the add-profile flow decided no freshness check was needed.
    await setActiveProfile('codex', 'new-active');
    mockReadSource.mockResolvedValue('live-new-active');

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    await __testHooks.doCreateProfile(cli!, 'created-from-stale-none', undefined, dispatch as any, refresh);

    expect(mockReadSource).not.toHaveBeenCalled();
    expect(await profileExists('codex', 'created-from-stale-none')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
    expect(lastAction(actions)).toMatchObject({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '활성 프로필 변경 감지 — 작업 취소'
      }
    });
  });

  it('cancels same-active switch when active changes after render-time no-op decision', async () => {
    const cli = findCliDef('codex');
    expect(cli).toBeDefined();
    await createProfile('codex', 'target');
    await createProfile('codex', 'other');
    await setActiveProfile('codex', 'target');

    // Simulate another foreground mutation after the UI rendered target as already active.
    await setActiveProfile('codex', 'other');
    mockReadSource.mockResolvedValue('live-other');

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    await __testHooks.doSwitch(cli!, 'target', dispatch as any, refresh, 'target');

    expect(mockReadSource).not.toHaveBeenCalled();
    expect(await getActiveProfile('codex')).toBe('other');
    expect(refresh).not.toHaveBeenCalled();
    expect(lastAction(actions)).toMatchObject({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '활성 프로필 변경 감지 — 작업 취소'
      }
    });
  });

  it('cancels first import when profiles appear after the prompt was shown', async () => {
    await createProfile('codex', 'created-elsewhere');
    mockReadSource.mockResolvedValue('live-created-elsewhere');

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    await __testHooks.onFirstImport(
      ['codex'],
      { codex: { active: undefined, profiles: [] } },
      dispatch as any,
      refresh
    );

    expect(mockReadSource).not.toHaveBeenCalled();
    expect(await profileExists('codex', 'default')).toBe(false);
    expect(refresh).toHaveBeenCalledOnce();
    expect(lastAction(actions)).toMatchObject({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '가져오기 실패'
      }
    });
    expect(lastAction(actions).screen.body).toContain('프로필 목록이 변경');
  });

  it('cancels first import when active changes after the prompt was shown', async () => {
    await setActiveProfile('codex', 'external-active');
    mockReadSource.mockResolvedValue('live-external-active');

    const { actions, dispatch } = dispatchRecorder();
    const refresh = vi.fn();

    await __testHooks.onFirstImport(
      ['codex'],
      { codex: { active: undefined, profiles: [] } },
      dispatch as any,
      refresh
    );

    expect(mockReadSource).not.toHaveBeenCalled();
    expect(await profileExists('codex', 'default')).toBe(false);
    expect(await getActiveProfile('codex')).toBe('external-active');
    expect(refresh).toHaveBeenCalledOnce();
    expect(lastAction(actions)).toMatchObject({
      type: 'replace',
      screen: {
        kind: 'message',
        tone: 'error',
        title: '가져오기 실패'
      }
    });
    expect(lastAction(actions).screen.body).toContain('활성 프로필을 변경');
  });
});
