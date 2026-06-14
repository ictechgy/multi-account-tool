/**
 * `mat doctor` — read-only safety diagnostics.
 *
 * This module intentionally avoids credential-value reads. It checks profile metadata,
 * active profile pointers, file/keychain source presence where that can be done
 * without revealing secret values, and high-confidence ambient override channels.
 * Deep OAuth comparison remains the job of the explicit `mat freshness` command.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { getAllCliDefs, getCliDefsWarnings } from './cli-defs.js';
import { loadConfig } from './config.js';
import { errorMessage, redactMessage } from './errors.js';
import { expandTilde, dataDir } from './paths.js';
import { listProfiles, profileExists } from './profile-store.js';
import { sourceExists } from './sources.js';
import { doctorSessionSupportForCli } from './support.js';
import type { CliDef, Config, Source } from './types.js';

export type DoctorStatus = 'ok' | 'warning' | 'error';
export type SourcePresenceStatus = 'present' | 'missing' | 'not-checked' | 'error';

export interface DoctorIssue {
  severity: DoctorStatus;
  code: string;
  message: string;
}

export interface DoctorSourceStatus {
  saveAs: string;
  type: Source['type'];
  status: SourcePresenceStatus;
  detail?: string;
  error?: string;
}

export interface DoctorFreshnessStatus {
  status: 'not-run';
  reason: string;
  command: string;
}

export interface DoctorCliReport {
  id: string;
  name: string;
  activeProfile?: string;
  activeProfileExists: boolean | null;
  profilesCount: number;
  sources: DoctorSourceStatus[];
  session: {
    start: 'supported' | 'unsupported' | 'experimental';
    run: 'supported' | 'unsupported';
  };
  freshness: DoctorFreshnessStatus;
  issues: DoctorIssue[];
}

export interface DoctorCheck {
  id: string;
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  schemaVersion: 1;
  generatedAt: string;
  platform: NodeJS.Platform;
  dataDir: string;
  summary: {
    status: DoctorStatus;
    ok: number;
    warnings: number;
    errors: number;
  };
  pluginWarnings: string[];
  checks: DoctorCheck[];
  clis: DoctorCliReport[];
}

export interface RunDoctorOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  now?: Date;
}

interface AmbientRule {
  envNames?: string[];
  envPrefixes?: string[];
  cwdEntries?: string[];
}

const DOCTOR_SCHEMA_VERSION = 1 as const;
const SECRET_TOOL_BIN = '/usr/bin/secret-tool';

const AMBIENT_RULES: Record<string, AmbientRule> = {
  claude: {
    envNames: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
  },
  codex: {
    envNames: ['OPENAI_API_KEY', 'CODEX_HOME']
  },
  gemini: {
    envNames: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION']
  },
  aider: {
    envPrefixes: ['AIDER_'],
    cwdEntries: ['.env', '.aider.conf.yml']
  },
  kimi: {
    envNames: ['MOONSHOT_API_KEY', 'KIMI_API_KEY']
  },
  qwen: {
    envNames: ['DASHSCOPE_API_KEY', 'QWEN_API_KEY', 'OPENAI_API_KEY'],
    cwdEntries: ['.qwen', '.env']
  },
  crush: {
    envPrefixes: ['CRUSH_GLOBAL_'],
    cwdEntries: ['.crush.json', 'crush.json']
  },
  opencode: {
    envNames: ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_AUTH_CONTENT'],
    cwdEntries: ['.opencode', 'opencode.json', 'opencode.jsonc']
  },
  goose: {
    envNames: ['GOOSE_DISABLE_KEYRING', 'GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']
  }
};

function issue(severity: DoctorStatus, code: string, message: string): DoctorIssue {
  return { severity, code, message: redactMessage(message) };
}

function check(id: string, status: DoctorStatus, message: string): DoctorCheck {
  return { id, status, message: redactMessage(message) };
}

function aggregateStatus(issues: DoctorIssue[]): DoctorStatus {
  if (issues.some((i) => i.severity === 'error')) return 'error';
  if (issues.some((i) => i.severity === 'warning')) return 'warning';
  return 'ok';
}

async function existsNoFollow(path: string): Promise<{ exists: boolean; kind?: string }> {
  try {
    const st = await fs.lstat(path);
    if (st.isSymbolicLink()) return { exists: true, kind: 'symlink' };
    if (st.isDirectory()) return { exists: true, kind: 'directory' };
    if (st.isFile()) return { exists: true, kind: 'file' };
    return { exists: true, kind: 'special' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false };
    throw err;
  }
}

async function inspectFileSource(src: Extract<Source, { type: 'file' }>): Promise<DoctorSourceStatus> {
  try {
    const found = await existsNoFollow(expandTilde(src.path));
    return {
      saveAs: redactMessage(src.saveAs),
      type: src.type,
      status: found.exists ? 'present' : 'missing',
      detail: found.exists ? `exists:${found.kind ?? 'unknown'}` : undefined
    };
  } catch (err) {
    return {
      saveAs: redactMessage(src.saveAs),
      type: src.type,
      status: 'error',
      error: errorMessage(err)
    };
  }
}

async function inspectKeychainSource(src: Extract<Source, { type: 'keychain' }>): Promise<DoctorSourceStatus> {
  try {
    const exists = await sourceExists(src);
    return { saveAs: redactMessage(src.saveAs), type: src.type, status: exists ? 'present' : 'missing' };
  } catch (err) {
    return { saveAs: redactMessage(src.saveAs), type: src.type, status: 'error', error: errorMessage(err) };
  }
}

async function inspectOsKeyringSource(src: Extract<Source, { type: 'os-keyring' }>): Promise<DoctorSourceStatus> {
  // `secret-tool search --all` includes secret values in stdout. For PR-A's no-secret-read
  // contract, doctor only checks whether the helper binary exists and does not query entries.
  try {
    await fs.access(SECRET_TOOL_BIN);
    return {
      saveAs: redactMessage(src.saveAs),
      type: src.type,
      status: 'not-checked',
      detail: 'secret-tool present; entry presence not checked to avoid keyring secret reads'
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {
        saveAs: redactMessage(src.saveAs),
        type: src.type,
        status: 'not-checked',
        detail: 'secret-tool missing; install libsecret-tools or use file backend if supported'
      };
    }
    return { saveAs: redactMessage(src.saveAs), type: src.type, status: 'error', error: errorMessage(err) };
  }
}

async function inspectSource(src: Source): Promise<DoctorSourceStatus> {
  switch (src.type) {
    case 'file':
      return inspectFileSource(src);
    case 'keychain':
      return inspectKeychainSource(src);
    case 'os-keyring':
      return inspectOsKeyringSource(src);
    default: {
      const neverSrc: never = src;
      return neverSrc;
    }
  }
}

async function cwdEntryIssue(cliId: string, entry: string, cwd: string): Promise<DoctorIssue | null> {
  try {
    const found = await existsNoFollow(join(cwd, entry));
    if (!found.exists) return null;
    return issue(
      'warning',
      'ambient.cwd',
      `${cliId}: cwd contains ${entry} (${found.kind ?? 'unknown'}), which may override mat-selected credentials/config`
    );
  } catch (err) {
    return issue('warning', 'ambient.cwd.unreadable', `${cliId}: could not inspect cwd entry ${entry}: ${errorMessage(err)}`);
  }
}

async function ambientIssues(cliId: string, env: NodeJS.ProcessEnv, cwd: string): Promise<DoctorIssue[]> {
  const rules = AMBIENT_RULES[cliId];
  if (!rules) return [];
  const issues: DoctorIssue[] = [];
  const envKeys = Object.keys(env);
  for (const name of rules.envNames ?? []) {
    if (env[name] != null) {
      issues.push(issue('warning', 'ambient.env', `${cliId}: env ${name} is set and may override mat-selected credentials/config`));
    }
  }
  for (const prefix of rules.envPrefixes ?? []) {
    for (const key of envKeys) {
      if (key.startsWith(prefix)) {
        issues.push(issue('warning', 'ambient.env', `${cliId}: env ${key} is set and may override mat-selected credentials/config`));
      }
    }
  }
  for (const entry of rules.cwdEntries ?? []) {
    const found = await cwdEntryIssue(cliId, entry, cwd);
    if (found) issues.push(found);
  }
  return issues;
}

async function inspectCli(cli: CliDef, activeProfile: string | undefined, env: NodeJS.ProcessEnv, cwd: string): Promise<DoctorCliReport> {
  const issues: DoctorIssue[] = [];
  let profilesCount = 0;
  try {
    profilesCount = (await listProfiles(cli.id)).length;
  } catch (err) {
    issues.push(issue('error', 'profiles.list.error', `${cli.id}: could not list profiles: ${errorMessage(err)}`));
  }

  let activeProfileExists: boolean | null = null;
  if (activeProfile == null) {
    issues.push(issue('warning', 'active.missing', `${cli.id}: active profile is not set`));
  } else {
    try {
      activeProfileExists = await profileExists(cli.id, activeProfile);
      if (!activeProfileExists) {
        issues.push(issue('warning', 'active.profile-missing', `${cli.id}: active profile '${activeProfile}' does not exist`));
      }
    } catch (err) {
      activeProfileExists = null;
      issues.push(issue('error', 'active.profile-check-error', `${cli.id}: active profile check failed: ${errorMessage(err)}`));
    }
  }

  const sources = await Promise.all(cli.sources.map(inspectSource));
  for (const src of sources) {
    if (src.status === 'error') {
      issues.push(issue('error', 'source.error', `${cli.id}/${src.saveAs}: ${src.error ?? 'source check failed'}`));
    } else if (src.status === 'not-checked') {
      issues.push(issue('warning', 'source.not-checked', `${cli.id}/${src.saveAs}: ${src.detail ?? 'not checked'}`));
    }
  }

  issues.push(...await ambientIssues(cli.id, env, cwd));

  const session = doctorSessionSupportForCli(cli);

  return {
    id: cli.id,
    name: redactMessage(cli.name),
    activeProfile: activeProfile == null ? undefined : redactMessage(activeProfile),
    activeProfileExists,
    profilesCount,
    sources,
    session,
    freshness: {
      status: 'not-run',
      reason: 'doctor avoids credential-value reads; run explicit freshness check when needed',
      command: `mat freshness ${cli.id}`
    },
    issues
  };
}

export async function runDoctor(options: RunDoctorOptions = {}): Promise<DoctorReport> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const checks: DoctorCheck[] = [];
  let cfg: Config;
  try {
    cfg = await loadConfig();
    checks.push(check('config', 'ok', 'config loaded'));
  } catch (err) {
    cfg = { version: 1, active: {} };
    checks.push(check('config', 'error', `could not load config: ${errorMessage(err)}`));
  }
  const clis = getAllCliDefs();
  const pluginWarnings = getCliDefsWarnings().map(redactMessage);
  const reports = await Promise.all(clis.map((cli) => inspectCli(cli, cfg.active[cli.id], env, cwd)));
  const allIssues = reports.flatMap((cli) => cli.issues);

  if (pluginWarnings.length > 0) {
    checks.push(check('plugins', 'warning', `${pluginWarnings.length} plugin warning(s)`));
  } else {
    checks.push(check('plugins', 'ok', 'no plugin warnings'));
  }

  const unknownActive = Object.keys(cfg.active).filter((id) => !clis.some((cli) => cli.id === id));
  if (unknownActive.length > 0) {
    checks.push(check('active.unknown-cli', 'warning', `active profiles exist for unknown CLI ids: ${unknownActive.map(redactMessage).join(', ')}`));
  } else {
    checks.push(check('active.unknown-cli', 'ok', 'no active profiles for unknown CLI ids'));
  }

  const warnings = allIssues.filter((i) => i.severity === 'warning').length + checks.filter((c) => c.status === 'warning').length;
  const errors = allIssues.filter((i) => i.severity === 'error').length + checks.filter((c) => c.status === 'error').length;
  const ok = reports.filter((cli) => aggregateStatus(cli.issues) === 'ok').length + checks.filter((c) => c.status === 'ok').length;
  return {
    schemaVersion: DOCTOR_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    platform: process.platform,
    dataDir: dataDir(),
    summary: {
      status: errors > 0 ? 'error' : warnings > 0 ? 'warning' : 'ok',
      ok,
      warnings,
      errors
    },
    pluginWarnings,
    checks,
    clis: reports
  };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`mat doctor — ${report.summary.status.toUpperCase()} (${report.summary.warnings} warning, ${report.summary.errors} error)`);
  lines.push(`platform: ${report.platform}`);
  lines.push(`dataDir: ${report.dataDir}`);
  if (report.pluginWarnings.length > 0) {
    lines.push('');
    lines.push('Plugin warnings:');
    for (const warning of report.pluginWarnings) lines.push(`  - ${warning}`);
  }
  lines.push('');
  lines.push('CLI diagnostics:');
  for (const cli of report.clis) {
    const cliStatus = aggregateStatus(cli.issues).toUpperCase();
    lines.push(`  ${cli.id} (${cli.name}) — ${cliStatus}`);
    lines.push(`    active: ${cli.activeProfile ?? '(none)'}${cli.activeProfileExists === false ? ' [missing]' : ''}`);
    lines.push(`    profiles: ${cli.profilesCount}`);
    lines.push(`    session: start=${cli.session.start}, run=${cli.session.run}`);
    lines.push(`    freshness: not-run (use: ${cli.freshness.command})`);
    for (const src of cli.sources) {
      lines.push(`    source ${src.saveAs} [${src.type}]: ${src.status}${src.detail ? ` — ${src.detail}` : ''}${src.error ? ` — ${src.error}` : ''}`);
    }
    for (const item of cli.issues) {
      lines.push(`    ${item.severity.toUpperCase()} ${item.code}: ${item.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
