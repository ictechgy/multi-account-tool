import { promises as fs } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  currentCliMutationLockBody,
  isCliMutationLockHeldFor,
  withCliMutationLock
} from '../../src/core/cli-mutation-lock.js';
import { LockHeldError, acquireCliLock } from '../../src/core/lockfile.js';
import { cliLockPath } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('cli-mutation-lock.withCliMutationLock', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it('success path: context is visible inside fn and cleared after release', async () => {
    const result = await withCliMutationLock(
      { cliId: 'codex', profileName: 'work' },
      async () => {
        expect(isCliMutationLockHeldFor('codex')).toBe(true);
        expect(currentCliMutationLockBody('codex')?.profile).toBe('work');
        return 42;
      }
    );

    expect(result).toBe(42);
    expect(isCliMutationLockHeldFor('codex')).toBe(false);
    await expect(fs.access(cliLockPath('codex'))).rejects.toThrow();
  });

  it('thrown fn: original error propagates, lock is released, context is cleared', async () => {
    await expect(withCliMutationLock(
      { cliId: 'codex', profileName: 'work' },
      async () => {
        expect(isCliMutationLockHeldFor('codex')).toBe(true);
        throw new Error('boom');
      }
    )).rejects.toThrow('boom');

    expect(isCliMutationLockHeldFor('codex')).toBe(false);
    await expect(fs.access(cliLockPath('codex'))).rejects.toThrow();
  });

  it('failed acquire: fn is not called and no context is set', async () => {
    const release = await acquireCliLock('codex', 'holder');
    const fn = vi.fn();
    try {
      await expect(withCliMutationLock(
        { cliId: 'codex', profileName: 'work' },
        fn
      )).rejects.toBeInstanceOf(LockHeldError);
      expect(fn).not.toHaveBeenCalled();
      expect(isCliMutationLockHeldFor('codex')).toBe(false);
    } finally {
      await release();
    }
  });

  it('same-CLI nested call reuses the outer context instead of reacquiring', async () => {
    await withCliMutationLock(
      { cliId: 'codex', profileName: 'outer' },
      async ({ body: outer }) => {
        await withCliMutationLock(
          { cliId: 'codex', profileName: 'inner' },
          async ({ body: inner }) => {
            expect(inner.token).toBe(outer.token);
            expect(inner.profile).toBe('outer');
          }
        );
        expect(isCliMutationLockHeldFor('codex')).toBe(true);
      }
    );
  });

  it('detached same-CLI continuation after release reacquires instead of reusing stale context', async () => {
    let releaseGate: () => void = () => {};
    const afterRelease = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    let detached:
      | Promise<{
        heldAfterRelease: boolean;
        fsLockWasFree: boolean;
        reusedOuterToken: boolean;
        innerProfile: string;
      }>
      | undefined;
    let outerToken = '';

    await withCliMutationLock(
      { cliId: 'codex', profileName: 'outer' },
      async ({ body: outer }) => {
        outerToken = outer.token;
        detached = (async () => {
          await afterRelease;
          const heldAfterRelease = isCliMutationLockHeldFor('codex');
          const fsLockWasFree = await fs.access(cliLockPath('codex')).then(
            () => false,
            () => true
          );
          let innerToken = '';
          let innerProfile = '';

          await withCliMutationLock(
            { cliId: 'codex', profileName: 'inner' },
            async ({ body: inner }) => {
              innerToken = inner.token;
              innerProfile = inner.profile;
            }
          );

          return {
            heldAfterRelease,
            fsLockWasFree,
            reusedOuterToken: innerToken === outer.token,
            innerProfile
          };
        })();
      }
    );

    releaseGate();
    expect(detached).toBeDefined();
    const result = await detached;
    expect(outerToken).not.toBe('');
    expect(result).toEqual({
      heldAfterRelease: false,
      fsLockWasFree: true,
      reusedOuterToken: false,
      innerProfile: 'inner'
    });
    await expect(fs.access(cliLockPath('codex'))).rejects.toThrow();
  });

  it('different-CLI nested call acquires an independent context and restores the outer one', async () => {
    await withCliMutationLock(
      { cliId: 'codex', profileName: 'work' },
      async () => {
        expect(isCliMutationLockHeldFor('codex')).toBe(true);
        expect(isCliMutationLockHeldFor('gemini')).toBe(false);
        await withCliMutationLock(
          { cliId: 'gemini', profileName: 'other' },
          async () => {
            expect(isCliMutationLockHeldFor('codex')).toBe(true);
            expect(isCliMutationLockHeldFor('gemini')).toBe(true);
          }
        );
        expect(isCliMutationLockHeldFor('codex')).toBe(true);
        expect(isCliMutationLockHeldFor('gemini')).toBe(false);
      }
    );

    expect(isCliMutationLockHeldFor('codex')).toBe(false);
    expect(isCliMutationLockHeldFor('gemini')).toBe(false);
  });
});
