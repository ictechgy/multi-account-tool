/**
 * Read-only status report for shell/statusline/dashboard consumers.
 */

import { loadConfig } from './config.js';
import { formatProfileIdentity, normalizeIsoString, normalizeProfileIdentity } from './profile-identity.js';
import { readMeta } from './profile-store.js';
import { buildSessionListReport } from './session.js';
import type { ProfileIdentitySummary } from './types.js';

export interface StatusActiveProfile {
  cliId: string;
  profileName: string;
  updatedAt?: string;
  identity?: ProfileIdentitySummary;
  metadataIssue?: 'missing' | 'invalid' | 'unreadable';
}

export interface StatusSessionSummary {
  total: number;
  active: number;
  orphan: number;
  unknown: number;
}

export interface StatusReport {
  schemaVersion: 1;
  generatedAt: string;
  activeProfiles: StatusActiveProfile[];
  sessions: StatusSessionSummary;
}

export async function buildStatusReport(): Promise<StatusReport> {
  const [config, sessionReport] = await Promise.all([loadConfig(), buildSessionListReport()]);
  const activeProfiles = await Promise.all(
    Object.entries(config.active)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([cliId, profileName]) => buildActiveProfileStatus(cliId, profileName))
  );
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activeProfiles: activeProfiles.sort((a, b) => a.cliId.localeCompare(b.cliId)),
    sessions: {
      total: sessionReport.summary.total,
      active: sessionReport.summary.active,
      orphan: sessionReport.summary.orphan,
      unknown: sessionReport.summary.unknown
    }
  };
}

async function buildActiveProfileStatus(
  cliId: string,
  profileName: string
): Promise<StatusActiveProfile> {
  try {
    const meta = await readMeta(cliId, profileName);
    if (!meta) return { cliId, profileName, metadataIssue: 'missing' };
    return {
      cliId,
      profileName,
      updatedAt: normalizeIsoString(meta.updatedAt),
      identity: normalizeProfileIdentity(meta.identity),
      ...(!normalizeIsoString(meta.updatedAt) ? { metadataIssue: 'invalid' as const } : {})
    };
  } catch {
    return { cliId, profileName, metadataIssue: 'unreadable' };
  }
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push('mat status');
  if (report.activeProfiles.length === 0) {
    lines.push('active profiles: (none)');
  } else {
    lines.push('active profiles:');
    for (const active of report.activeProfiles) {
      const issue = active.metadataIssue ? ` [metadata:${active.metadataIssue}]` : '';
      lines.push(`  - ${active.cliId}: ${active.profileName}${issue}`);
      if (active.updatedAt) lines.push(`      updatedAt: ${active.updatedAt}`);
      lines.push(`      ${formatProfileIdentity(active.identity)}`);
    }
  }
  lines.push(
    `sessions: total=${report.sessions.total} active=${report.sessions.active} ` +
      `orphan=${report.sessions.orphan} unknown=${report.sessions.unknown}`
  );
  return `${lines.join('\n')}\n`;
}
