import { promises as fs } from 'node:fs';
import { join } from 'node:path';

import { errorMessage, redactMessage } from './errors.js';

export type AmbientWarningCode = 'ambient.env' | 'ambient.cwd' | 'ambient.cwd.unreadable';
export type AmbientWarningChannel = 'env' | 'cwd';

export interface AmbientWarning {
  code: AmbientWarningCode;
  severity: 'warning';
  cliId: string;
  channel: AmbientWarningChannel;
  name: string;
  message: string;
  detail?: string;
}

export interface DetectAmbientOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

interface AmbientRule {
  envNames?: string[];
  envPrefixes?: string[];
  cwdEntries?: string[];
}

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
    envNames: [
      'ANTHROPIC_API_KEY',
      'BAILIAN_CODING_PLAN_API_KEY',
      'BAILIAN_TOKEN_PLAN_API_KEY',
      'DASHSCOPE_API_KEY',
      'DEEPSEEK_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'IDEALAB_API_KEY',
      'MINIMAX_API_KEY',
      'MODELSCOPE_API_KEY',
      'OPENAI_API_KEY',
      'OPENROUTER_API_KEY',
      'QWEN_API_KEY',
      'REQUESTY_API_KEY',
      'XAI_API_KEY',
      'ZAI_API_KEY'
    ],
    envPrefixes: ['QWEN_CUSTOM_API_KEY_'],
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
    envNames: ['GOOSE_DISABLE_KEYRING', 'GOOSE_PROVIDER', 'GOOSE_MODEL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN']
  },
  grok: {
    envNames: ['XAI_API_KEY'],
    envPrefixes: ['GROK_'],
    cwdEntries: ['.grok']
  }
};

function warning(code: AmbientWarningCode, cliId: string, channel: AmbientWarningChannel, name: string, message: string, detail?: string): AmbientWarning {
  return {
    code,
    severity: 'warning',
    cliId,
    channel,
    name: redactMessage(name),
    message: redactMessage(message),
    detail: detail == null ? undefined : redactMessage(detail)
  };
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

async function cwdEntryWarning(cliId: string, entry: string, cwd: string): Promise<AmbientWarning | null> {
  try {
    const found = await existsNoFollow(join(cwd, entry));
    if (!found.exists) return null;
    const kind = found.kind ?? 'unknown';
    return warning(
      'ambient.cwd',
      cliId,
      'cwd',
      entry,
      `${cliId}: cwd contains ${entry} (${kind}), which may override mat-selected credentials/config`,
      kind
    );
  } catch (err) {
    return warning(
      'ambient.cwd.unreadable',
      cliId,
      'cwd',
      entry,
      `${cliId}: could not inspect cwd entry ${entry}: ${errorMessage(err)}`
    );
  }
}

function currentWorkingDirectory(cliId: string): { cwd?: string; warning?: AmbientWarning } {
  try {
    return { cwd: process.cwd() };
  } catch (err) {
    return {
      warning: warning(
        'ambient.cwd.unreadable',
        cliId,
        'cwd',
        '<cwd>',
        `${cliId}: could not inspect cwd: ${errorMessage(err)}`
      )
    };
  }
}

export async function detectAmbientWarnings(cliId: string, options: DetectAmbientOptions = {}): Promise<AmbientWarning[]> {
  const rules = AMBIENT_RULES[cliId];
  if (!rules) return [];
  const env = options.env ?? process.env;
  const warnings: AmbientWarning[] = [];
  const envKeys = Object.keys(env);
  for (const name of rules.envNames ?? []) {
    if (Object.prototype.hasOwnProperty.call(env, name)) {
      warnings.push(warning(
        'ambient.env',
        cliId,
        'env',
        name,
        `${cliId}: env ${name} is set and may override mat-selected credentials/config`
      ));
    }
  }
  for (const prefix of rules.envPrefixes ?? []) {
    for (const key of envKeys) {
      if (key.startsWith(prefix)) {
        warnings.push(warning(
          'ambient.env',
          cliId,
          'env',
          key,
          `${cliId}: env ${key} is set and may override mat-selected credentials/config`
        ));
      }
    }
  }
  if ((rules.cwdEntries?.length ?? 0) > 0) {
    const cwdResult = options.cwd == null ? currentWorkingDirectory(cliId) : { cwd: options.cwd };
    if (cwdResult.warning) warnings.push(cwdResult.warning);
    if (cwdResult.cwd) {
      for (const entry of rules.cwdEntries ?? []) {
        const found = await cwdEntryWarning(cliId, entry, cwdResult.cwd);
        if (found) warnings.push(found);
      }
    }
  }
  return warnings;
}

export function formatAmbientWarnings(warnings: AmbientWarning[], options: { header?: string } = {}): string {
  if (warnings.length === 0) return '';
  const lines: string[] = [];
  lines.push(options.header ?? '[mat] ambient credential/config warning');
  for (const item of warnings) lines.push(`  - ${item.message}`);
  lines.push('Profile operation continues; unset/scrub these channels if unintended.');
  return lines.join('\n');
}
