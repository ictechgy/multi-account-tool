/**
 * Read-only status report for shell/statusline/dashboard consumers.
 */

import { loadConfig } from './config.js';
import { buildSessionListReport } from './session.js';

export interface StatusActiveProfile {
  cliId: string;
  profileName: string;
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
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activeProfiles: Object.entries(config.active)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([cliId, profileName]) => ({ cliId, profileName }))
      .sort((a, b) => a.cliId.localeCompare(b.cliId)),
    sessions: {
      total: sessionReport.summary.total,
      active: sessionReport.summary.active,
      orphan: sessionReport.summary.orphan,
      unknown: sessionReport.summary.unknown
    }
  };
}

export function formatStatusReport(report: StatusReport): string {
  const lines: string[] = [];
  lines.push('mat status');
  if (report.activeProfiles.length === 0) {
    lines.push('active profiles: (none)');
  } else {
    lines.push('active profiles:');
    for (const active of report.activeProfiles) {
      lines.push(`  - ${active.cliId}: ${active.profileName}`);
    }
  }
  lines.push(
    `sessions: total=${report.sessions.total} active=${report.sessions.active} ` +
      `orphan=${report.sessions.orphan} unknown=${report.sessions.unknown}`
  );
  return `${lines.join('\n')}\n`;
}
