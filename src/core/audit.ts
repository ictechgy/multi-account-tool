/**
 * Stable, redacted JSONL audit log for lifecycle observability.
 *
 * This module is intentionally best-effort: callers must never let audit write
 * failures change command exit semantics. Only already-mutating lifecycle paths
 * should call it; read-only status/list commands must not create audit files.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import { maskIdentifier } from './errors.js';
import { auditLogPath } from './paths.js';
import { redactSecretLikeText } from './redaction.js';

export const AUDIT_LOG_MAX_BYTES = 1024 * 1024;

const AUDIT_REDACT_OPTIONS = {
  secretMarker: '<redacted:secret>',
  jwtMarker: '<redacted:jwt>',
  longSecretMin: 32,
  maxLength: 512
};

export type AuditEventName =
  | 'session.start'
  | 'session.end'
  | 'session.stop'
  | 'session.reap';

export interface AuditEventInput {
  event: AuditEventName;
  cli?: string;
  profile?: string;
  sessionId?: string;
  commandKind?: 'shell' | 'command';
  outcome?: string;
  reason?: string;
  exitCode?: number | null;
  signal?: string | null;
  recaptureFailed?: boolean;
  error?: unknown;
}

export interface AuditEventV1 {
  schemaVersion: 1;
  ts: string;
  event: AuditEventName;
  cli?: string;
  profileHash?: string;
  sessionIdHash?: string;
  commandKind?: 'shell' | 'command';
  outcome?: string;
  reason?: string;
  exitCode?: number | null;
  signal?: string | null;
  recaptureFailed?: boolean;
  error?: string;
}

function redactAuditText(value: string): string {
  return redactSecretLikeText(value, AUDIT_REDACT_OPTIONS);
}

function cleanIdentifier(value: string): string {
  // Persist only a fingerprint, never the raw identifier. Hash the raw value
  // instead of a redacted placeholder so long/profile-like identifiers remain
  // distinguishable in audit correlation while still avoiding raw disclosure.
  return maskIdentifier(value);
}

function cleanShort(value: string): string {
  return redactAuditText(value).slice(0, AUDIT_REDACT_OPTIONS.maxLength);
}

function cleanNumber(value: number | null | undefined): number | null | undefined {
  if (value == null) return value;
  return Number.isSafeInteger(value) ? value : undefined;
}

export function normalizeAuditEvent(input: AuditEventInput, now = new Date()): AuditEventV1 {
  const out: AuditEventV1 = {
    schemaVersion: 1,
    ts: now.toISOString(),
    event: input.event
  };
  if (input.cli != null) out.cli = cleanShort(input.cli);
  if (input.profile != null) out.profileHash = cleanIdentifier(input.profile);
  if (input.sessionId != null) out.sessionIdHash = cleanIdentifier(input.sessionId);
  if (input.commandKind != null) out.commandKind = input.commandKind;
  if (input.outcome != null) out.outcome = cleanShort(input.outcome);
  if (input.reason != null) out.reason = cleanShort(input.reason);
  if (input.exitCode !== undefined) out.exitCode = cleanNumber(input.exitCode);
  if (input.signal !== undefined) out.signal = input.signal == null ? null : cleanShort(input.signal);
  if (input.recaptureFailed !== undefined) out.recaptureFailed = Boolean(input.recaptureFailed);
  if (input.error != null) {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    out.error = cleanShort(message);
  }
  return out;
}

async function rotateIfNeeded(path: string): Promise<void> {
  const stat = await fs.stat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return null;
    throw err;
  });
  if (!stat || stat.size <= AUDIT_LOG_MAX_BYTES) return;
  await fs.rm(`${path}.1`, { force: true });
  await fs.rename(path, `${path}.1`).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
  });
}

export async function appendAuditEventBestEffort(input: AuditEventInput): Promise<void> {
  try {
    const path = auditLogPath();
    await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await rotateIfNeeded(path);
    await fs.appendFile(path, `${JSON.stringify(normalizeAuditEvent(input))}\n`, { mode: 0o600 });
  } catch {
    // Best-effort by design. Audit failures must not alter command behavior.
  }
}
