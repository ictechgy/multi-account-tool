/**
 * Per-CLI foreground credential mutation transaction helper.
 *
 * The filesystem lock in lockfile.ts is still the source of truth. This module
 * only adds in-process, async-scoped awareness so public switcher APIs can be
 * safely composed while a caller already holds the same CLI lock (notably
 * `mat exec` and TUI compound flows). The scope is CLI-specific: holding the
 * codex lock never suppresses acquiring the gemini lock.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import {
  acquireCliLockLease,
  type AcquireLockOptions,
  type CliLockLease,
  type LockBody
} from './lockfile.js';
import { validateCliId, validateProfileName } from './paths.js';

interface CliMutationLockOptions extends AcquireLockOptions {
  cliId: string;
  profileName: string;
}

export interface CliMutationLockContext {
  body: LockBody;
}

interface CliMutationLockRecord {
  body: LockBody;
  token: string;
  active: boolean;
}

const lockContext = new AsyncLocalStorage<ReadonlyMap<string, CliMutationLockRecord>>();

export function isCliMutationLockHeldFor(cliId: string): boolean {
  const safeCli = validateCliId(cliId);
  return activeRecordFor(safeCli) != null;
}

export function currentCliMutationLockBody(cliId: string): LockBody | undefined {
  const safeCli = validateCliId(cliId);
  return activeRecordFor(safeCli)?.body;
}

export async function withCliMutationLock<T>(
  opts: CliMutationLockOptions,
  fn: (ctx: CliMutationLockContext) => Promise<T>
): Promise<T> {
  const safeCli = validateCliId(opts.cliId);
  const safeProfile = validateProfileName(opts.profileName);
  const safePreviousActive =
    opts.previousActive == null ? undefined : validateProfileName(opts.previousActive);
  const safeAffectsCliIds = opts.affectsCliIds?.map((id) => validateCliId(id));
  const existing = activeRecordFor(safeCli);
  if (existing) {
    // Same CLI is already protected by a real fs lock in this async scope.
    // Do not reacquire: mkdir-locks are intentionally non-reentrant.
    return fn({ body: existing.body });
  }

  const lease = await acquireCliLockLease(safeCli, safeProfile, {
    execMode: opts.execMode ?? 'foreground',
    previousActive: safePreviousActive,
    affectsCliIds: safeAffectsCliIds,
    prepareMetadata: opts.prepareMetadata
  });
  return runWithLease(safeCli, lease, fn);
}

function activeRecordFor(cliId: string): CliMutationLockRecord | undefined {
  const record = lockContext.getStore()?.get(cliId);
  if (record == null) return undefined;
  if (!record.active) return undefined;
  if (record.body.token !== record.token) return undefined;
  return record;
}

async function runWithLease<T>(
  cliId: string,
  lease: CliLockLease,
  fn: (ctx: CliMutationLockContext) => Promise<T>
): Promise<T> {
  const record: CliMutationLockRecord = {
    body: lease.body,
    token: lease.body.token,
    active: true
  };
  const next = new Map(lockContext.getStore() ?? []);
  next.set(cliId, record);
  try {
    return await lockContext.run(next, () => fn({ body: lease.body }));
  } finally {
    record.active = false;
    await lease.release();
  }
}
