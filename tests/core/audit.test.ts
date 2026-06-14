import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  appendAuditEventBestEffort,
  AUDIT_LOG_MAX_BYTES,
  normalizeAuditEvent
} from '../../src/core/audit.js';
import { auditLogPath } from '../../src/core/paths.js';
import { setupTmpHome, type TmpHome } from '../helpers/tmp-home.js';

describe('audit JSONL', () => {
  let tmp: TmpHome;

  beforeEach(async () => {
    tmp = await setupTmpHome();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await tmp.cleanup();
  });

  it('normalizes to schema v1 and hashes profile/session identifiers', () => {
    const event = normalizeAuditEvent(
      {
        event: 'session.start',
        cli: 'codex',
        profile: 'prod-profile',
        sessionId: 'codex-prod-profile-aaaaaaaa',
        commandKind: 'shell',
        outcome: 'started'
      },
      new Date('2026-06-14T00:00:00.000Z')
    );

    expect(event).toMatchObject({
      schemaVersion: 1,
      ts: '2026-06-14T00:00:00.000Z',
      event: 'session.start',
      cli: 'codex',
      commandKind: 'shell',
      outcome: 'started'
    });
    expect(event.profileHash).toMatch(/^<hash:[0-9a-f]{12}>$/);
    expect(event.sessionIdHash).toMatch(/^<hash:[0-9a-f]{12}>$/);
    expect(JSON.stringify(event)).not.toContain('prod-profile');
  });

  it('hashes long identifier values directly instead of collapsing them to redaction markers', () => {
    const first = normalizeAuditEvent({
      event: 'session.start',
      profile: 'very-long-profile-name-that-would-look-secret-one',
      sessionId: 'codex-very-long-profile-name-that-would-look-secret-one-aaaaaaaa'
    });
    const second = normalizeAuditEvent({
      event: 'session.start',
      profile: 'very-long-profile-name-that-would-look-secret-two',
      sessionId: 'codex-very-long-profile-name-that-would-look-secret-two-bbbbbbbb'
    });

    expect(first.profileHash).toMatch(/^<hash:[0-9a-f]{12}>$/);
    expect(first.sessionIdHash).toMatch(/^<hash:[0-9a-f]{12}>$/);
    expect(first.profileHash).not.toBe(second.profileHash);
    expect(first.sessionIdHash).not.toBe(second.sessionIdHash);
    expect(JSON.stringify(first)).not.toContain('very-long-profile-name');
  });

  it('redacts secret-like error strings before appending', async () => {
    await appendAuditEventBestEffort({
      event: 'session.end',
      cli: 'codex',
      profile: 'work',
      sessionId: 'codex-work-aaaaaaaa',
      outcome: 'spawn_error',
      error: 'Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz secretKey=ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
    });

    const line = await fs.readFile(auditLogPath(), 'utf8');
    expect(line).toContain('"schemaVersion":1');
    expect(line).toContain('<redacted:secret>');
    expect(line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    expect(line).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890');
    expect(line).not.toContain('codex-work-aaaaaaaa');
  });

  it('rotates when the log exceeds the size cap', async () => {
    const path = auditLogPath();
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, 'x'.repeat(AUDIT_LOG_MAX_BYTES + 1), { mode: 0o600 });

    await appendAuditEventBestEffort({ event: 'session.reap', sessionId: 'codex-work-aaaaaaaa' });

    await expect(fs.stat(`${path}.1`)).resolves.toMatchObject({ size: AUDIT_LOG_MAX_BYTES + 1 });
    const fresh = await fs.readFile(path, 'utf8');
    expect(fresh).toContain('"event":"session.reap"');
  });

  it('replaces a previous rotated audit log on repeated rotation', async () => {
    const path = auditLogPath();
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(`${path}.1`, 'old-rotation', { mode: 0o600 });
    await fs.writeFile(path, 'y'.repeat(AUDIT_LOG_MAX_BYTES + 1), { mode: 0o600 });

    await appendAuditEventBestEffort({ event: 'session.stop', sessionId: 'codex-work-bbbbbbbb' });

    const rotated = await fs.readFile(`${path}.1`, 'utf8');
    expect(rotated).not.toBe('old-rotation');
    expect(rotated).toHaveLength(AUDIT_LOG_MAX_BYTES + 1);
    const fresh = await fs.readFile(path, 'utf8');
    expect(fresh).toContain('"event":"session.stop"');
  });

  it('swallows append failures', async () => {
    vi.spyOn(fs, 'appendFile').mockRejectedValueOnce(new Error('disk full'));

    await expect(appendAuditEventBestEffort({ event: 'session.stop', sessionId: 'x' })).resolves.toBeUndefined();
  });

  it('swallows mkdir/rotation failures', async () => {
    vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('permission denied'));
    await expect(appendAuditEventBestEffort({ event: 'session.stop', sessionId: 'x' })).resolves.toBeUndefined();

    await fs.mkdir(dirname(auditLogPath()), { recursive: true });
    await fs.writeFile(auditLogPath(), 'x'.repeat(AUDIT_LOG_MAX_BYTES + 1));
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('rename denied'));
    await expect(appendAuditEventBestEffort({ event: 'session.stop', sessionId: 'x' })).resolves.toBeUndefined();
  });
});
