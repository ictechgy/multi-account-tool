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
    // `ANTHROPIC_BASE_URL` 은 자격증명 자체가 아니라 **목적지**를 바꾼다 — 설정돼 있으면 mat 이
    // 프로필 swap 을 성공으로 보고해도 세션 전체가 다른 provider/계정으로 라우팅된다
    // (예: z.ai GLM Coding Plan 은 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` 조합의
    // env 전용 통합이다 — docs.z.ai/devpack/tool/claude). 토큰만 경고하고 목적지 재지정을
    // 놓치면 격리 보고가 사실과 어긋난다.
    // `ANTHROPIC_DEFAULT_*_MODEL` 은 제외한다: mat 은 claude 의 routing 아티팩트를 캡처하지
    // 않으므로 env 가 모순시킬 캡처 대상이 없다 (goose 는 config.yaml 이 캡처되므로 대칭이
    // 성립해 GOOSE_MODEL 을 경고한다).
    envNames: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
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
    // `ANTHROPIC_HOST` (≠ `ANTHROPIC_BASE_URL`): goose 의 anthropic provider 가 실제로 읽는
    // 이름이다 — `crates/goose/src/providers/anthropic_def.rs:38-40` 의
    // `config.get_param("ANTHROPIC_HOST")` (기본 `https://api.anthropic.com`). 그리고
    // `Config::get_param` 은 `env::var(KEY)` 를 **먼저** 확인하고 즉시 반환하므로
    // (`crates/goose/src/config/base.rs:733-738`) env 가 캡처된 `config.yaml` 을 덮어쓴다.
    // mat 이 goose-config.yaml 을 캡처하므로 GOOSE_MODEL 경고와 동일 논리가 더 강하게 성립한다.
    // `ANTHROPIC_API_VERSION` 은 프로토콜 노브이며 계정 경계가 아니라 제외한다.
    //
    // `GOOSE_PATH_ROOT` / `XDG_CONFIG_HOME` 은 goose 의 `config_dir()` 리졸버 입력이다. 둘 중
    // 하나라도 설정되면 mat 의 고정 `~/.config/goose/**` 경로가 전부 존재하지 않게 되어,
    // 부재 source 는 skip 되므로 **전환이 성공을 보고하면서 실제로는 아무것도 스왑하지 않는다**
    // — 0.8.0 의 `providers/` 결함과 같은 클래스의 조용한 실패다. 경고는 완화이지 해결이 아니며
    //   근본 해결(리졸버 반영)은 후속 과제다.
    envNames: [
      'GOOSE_DISABLE_KEYRING', 'GOOSE_PROVIDER', 'GOOSE_MODEL',
      'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'HF_TOKEN',
      'ANTHROPIC_HOST', 'GOOSE_PATH_ROOT', 'XDG_CONFIG_HOME'
    ]
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
