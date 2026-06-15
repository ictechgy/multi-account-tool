export type AmpConfigOriginKind =
  | 'argv'
  | 'ambient-env'
  | 'user-settings'
  | 'workspace-settings'
  | 'custom-settings'
  | 'mcp-config'
  | 'managed-settings'
  | 'mcp-oauth'
  | 'plugin';

export type AmpHardStopCode =
  | 'ambient-amp-api-key'
  | 'settings-file-arg'
  | 'mcp-config-arg'
  | 'mcp-server-local-command'
  | 'mcp-server-local-args'
  | 'mcp-server-env'
  | 'mcp-server-header'
  | 'mcp-server-url'
  | 'mcp-server-url-env-substitution'
  | 'settings-env-substitution'
  | 'workspace-settings-present'
  | 'managed-settings-present'
  | 'plugin-config'
  | 'mcp-permission-override'
  | 'permission-override'
  | 'dangerously-allow-all'
  | 'mcp-oauth-state'
  | 'malformed-settings';

export interface AmpHardStopIssue {
  code: AmpHardStopCode;
  origin: AmpConfigOriginKind;
  /** Symbolic origin only, never an expanded host path. */
  originLabel?: string;
  /** CLI flag name only, never the flag value. */
  flag?: string;
  /** Settings key/path only, never a setting value. */
  settingPath?: string;
  /** Environment variable name only, never its value. */
  envName?: string;
  message: string;
}

export interface AmpSettingsInspectionInput {
  text: string;
  origin: AmpConfigOriginKind;
  /** Symbolic label such as `user-settings` or `workspace-settings`; not a file path. */
  originLabel?: string;
}

export interface AmpConfigCandidate {
  origin: AmpConfigOriginKind;
  originLabel: string;
  /** Documented path template only; never an expanded user/host path. */
  pathTemplate: string;
  mustHardStopIfExists: boolean;
}

type JsonObject = Record<string, unknown>;

const ENV_SUBSTITUTION_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export function inspectAmpArgv(args: readonly string[]): AmpHardStopIssue[] {
  const issues: AmpHardStopIssue[] = [];

  for (const arg of args) {
    if (arg === '--settings-file' || arg.startsWith('--settings-file=')) {
      issues.push(issue({
        code: 'settings-file-arg',
        origin: 'argv',
        flag: '--settings-file',
        message: 'Amp hard-stop: --settings-file can redirect account-affecting settings.'
      }));
    }

    if (arg === '--mcp-config' || arg.startsWith('--mcp-config=')) {
      issues.push(issue({
        code: 'mcp-config-arg',
        origin: 'argv',
        flag: '--mcp-config',
        message: 'Amp hard-stop: --mcp-config has highest-precedence MCP configuration.'
      }));
    }
  }

  return dedupeIssues(issues);
}

export function inspectAmpEnvironment(env: Record<string, string | undefined>): AmpHardStopIssue[] {
  const issues: AmpHardStopIssue[] = [];
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === 'AMP_API_KEY' && env[name] !== undefined) {
      issues.push(issue({
        code: 'ambient-amp-api-key',
        origin: 'ambient-env',
        envName: 'AMP_API_KEY',
        message: 'Amp hard-stop: inherited AMP_API_KEY is not proven profile-owned.'
      }));
    }
  }
  return dedupeIssues(issues);
}

export function inspectAmpSettingsText(input: AmpSettingsInspectionInput): AmpHardStopIssue[] {
  const originLabel = input.originLabel ?? input.origin;
  const parsed = parseJsoncObject(input.text);
  if (!parsed.ok) {
    return [issue({
      code: 'malformed-settings',
      origin: input.origin,
      originLabel,
      message: `Amp hard-stop: ${originLabel} is not parseable as a JSON object.`
    })];
  }

  const issues: AmpHardStopIssue[] = [];

  if (input.origin === 'workspace-settings') {
    issues.push(issue({
      code: 'workspace-settings-present',
      origin: input.origin,
      originLabel,
      message: 'Amp hard-stop: workspace settings can override user settings.'
    }));
  }

  if (input.origin === 'managed-settings') {
    issues.push(issue({
      code: 'managed-settings-present',
      origin: input.origin,
      originLabel,
      message: 'Amp hard-stop: managed settings can override user and workspace settings.'
    }));
  }

  if (input.origin === 'mcp-oauth') {
    issues.push(issue({
      code: 'mcp-oauth-state',
      origin: input.origin,
      originLabel,
      message: 'Amp hard-stop: MCP OAuth state is tool-server state, not primary Amp account material.'
    }));
  }

  if (input.origin === 'mcp-config') {
    inspectMcpServers(parsed.value, input.origin, originLabel, issues, 'mcp-config');
    const explicit = readSetting(parsed.value, 'amp.mcpServers');
    if (explicit !== undefined) {
      inspectMcpServers(explicit, input.origin, originLabel, issues, 'amp.mcpServers');
      inspectNonMcpSettingsObject(parsed.value, input.origin, originLabel, issues, []);
    }
  } else {
    inspectSettingsObject(parsed.value, input.origin, originLabel, issues, []);
  }

  return dedupeIssues(issues);
}

export function plannedAmpConfigCandidates(input: { platform?: NodeJS.Platform } = {}): AmpConfigCandidate[] {
  const platform = input.platform ?? 'linux';
  const candidates: AmpConfigCandidate[] = [];

  candidates.push({
    origin: 'workspace-settings',
    originLabel: 'workspace-settings',
    pathTemplate: '.amp/settings.json{,c}',
    mustHardStopIfExists: true
  });

  candidates.push({
    origin: 'mcp-oauth',
    originLabel: 'mcp-oauth-state',
    pathTemplate: '~/.amp/oauth/',
    mustHardStopIfExists: true
  });

  if (platform === 'win32') {
    candidates.push({
      origin: 'user-settings',
      originLabel: 'user-settings',
      pathTemplate: '%USERPROFILE%\\.config\\amp\\settings.json{,c}',
      mustHardStopIfExists: true
    });
    candidates.push({
      origin: 'managed-settings',
      originLabel: 'managed-settings',
      pathTemplate: '%ProgramData%\\ampcode\\managed-settings.json',
      mustHardStopIfExists: true
    });
    return candidates;
  }

  candidates.push({
    origin: 'user-settings',
    originLabel: 'user-settings',
    pathTemplate: '~/.config/amp/settings.json{,c}',
    mustHardStopIfExists: true
  });

  if (platform === 'darwin') {
    candidates.push({
      origin: 'managed-settings',
      originLabel: 'managed-settings',
      pathTemplate: '/Library/Application Support/ampcode/managed-settings.json',
      mustHardStopIfExists: true
    });
  } else {
    candidates.push({
      origin: 'managed-settings',
      originLabel: 'managed-settings',
      pathTemplate: '/etc/ampcode/managed-settings.json',
      mustHardStopIfExists: true
    });
  }

  return candidates;
}

export function formatAmpHardStopIssues(issues: readonly AmpHardStopIssue[]): string {
  return dedupeIssues(issues).map((hardStop) => {
    const parts = [hardStop.code, hardStop.originLabel ?? hardStop.origin];
    if (hardStop.flag) parts.push(hardStop.flag);
    if (hardStop.settingPath) parts.push(hardStop.settingPath);
    if (hardStop.envName) parts.push(hardStop.envName);
    return `${parts.join(' ')}: ${hardStop.message}`;
  }).join('\n');
}

function inspectSettingsObject(
  value: unknown,
  origin: AmpConfigOriginKind,
  originLabel: string,
  issues: AmpHardStopIssue[],
  path: string[]
): void {
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const settingPath = childPath.join('.');

    if (settingPath === 'amp.mcpServers') {
      inspectMcpServers(child, origin, originLabel, issues, 'amp.mcpServers');
      continue;
    }

    if (settingPath === 'amp.plugins') {
      issues.push(issue({
        code: 'plugin-config',
        origin,
        originLabel,
        settingPath,
        message: 'Amp hard-stop: plugin configuration can add executable tools or commands.'
      }));
    }

    if (settingPath === 'amp.mcpPermissions') {
      issues.push(issue({
        code: 'mcp-permission-override',
        origin,
        originLabel,
        settingPath,
        message: 'Amp hard-stop: MCP permission rules can change tool execution policy.'
      }));
    }

    if (settingPath === 'amp.permissions' || settingPath === 'amp.guardedFiles' || settingPath.startsWith('amp.guardedFiles.')) {
      issues.push(issue({
        code: 'permission-override',
        origin,
        originLabel,
        settingPath,
        message: 'Amp hard-stop: permission or guarded-file settings can change tool execution policy.'
      }));
    }

    if (settingPath === 'amp.dangerouslyAllowAll') {
      issues.push(issue({
        code: 'dangerously-allow-all',
        origin,
        originLabel,
        settingPath,
        message: 'Amp hard-stop: dangerouslyAllowAll can bypass tool-run safety controls.'
      }));
    }

    if (typeof child === 'string') {
      for (const envName of extractEnvSubstitutions(child)) {
        issues.push(issue({
          code: 'settings-env-substitution',
          origin,
          originLabel,
          settingPath,
          envName,
          message: `Amp hard-stop: ${settingPath} references ${envName} from the inherited environment.`
        }));
      }
    }

    inspectSettingsObject(child, origin, originLabel, issues, childPath);
  }
}

function inspectNonMcpSettingsObject(
  value: unknown,
  origin: AmpConfigOriginKind,
  originLabel: string,
  issues: AmpHardStopIssue[],
  path: string[]
): void {
  if (!isRecord(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const childPath = [...path, key];
    const settingPath = childPath.join('.');
    if (settingPath === 'amp.mcpServers') continue;
    inspectSettingsObject(child, origin, originLabel, issues, childPath);
  }
}

function inspectMcpServers(
  value: unknown,
  origin: AmpConfigOriginKind,
  originLabel: string,
  issues: AmpHardStopIssue[],
  basePath: string
): void {
  if (!isRecord(value)) {
    issues.push(issue({
      code: 'malformed-settings',
      origin,
      originLabel,
      settingPath: basePath,
      message: `Amp hard-stop: ${basePath} must be a JSON object to be inspected safely.`
    }));
    return;
  }

  for (const serverConfig of Object.values(value)) {
    if (!isRecord(serverConfig)) {
      issues.push(issue({
        code: 'malformed-settings',
        origin,
        originLabel,
        settingPath: `${basePath}.*`,
        message: `Amp hard-stop: ${basePath} entries must be JSON objects to be inspected safely.`
      }));
      continue;
    }

    if (hasOwn(serverConfig, 'command')) {
      issues.push(issue({
        code: 'mcp-server-local-command',
        origin,
        originLabel,
        settingPath: `${basePath}.*.command`,
        message: 'Amp hard-stop: local MCP command can execute outside the profile boundary.'
      }));
    }

    if (hasOwn(serverConfig, 'args')) {
      issues.push(issue({
        code: 'mcp-server-local-args',
        origin,
        originLabel,
        settingPath: `${basePath}.*.args`,
        message: 'Amp hard-stop: local MCP args can change executable behavior outside the profile boundary.'
      }));
    }

    if (hasOwn(serverConfig, 'env')) {
      const envValue = serverConfig.env;
      if (isRecord(envValue)) {
        for (const envName of Object.keys(envValue)) {
          issues.push(issue({
            code: 'mcp-server-env',
            origin,
            originLabel,
            settingPath: `${basePath}.*.env`,
            envName,
            message: `Amp hard-stop: MCP env references ${envName} outside profile ownership.`
          }));
        }
        inspectMcpValueSubstitutions(envValue, origin, originLabel, issues, `${basePath}.*.env`);
      } else {
        issues.push(issue({
          code: 'mcp-server-env',
          origin,
          originLabel,
          settingPath: `${basePath}.*.env`,
          message: 'Amp hard-stop: MCP env can introduce unowned credential channels.'
        }));
      }
    }

    if (hasOwn(serverConfig, 'headers')) {
      issues.push(issue({
        code: 'mcp-server-header',
        origin,
        originLabel,
        settingPath: `${basePath}.*.headers`,
        message: 'Amp hard-stop: remote MCP headers can carry credential material.'
      }));
      inspectMcpValueSubstitutions(serverConfig.headers, origin, originLabel, issues, `${basePath}.*.headers`);
    }

    if (hasOwn(serverConfig, 'url')) {
      issues.push(issue({
        code: 'mcp-server-url',
        origin,
        originLabel,
        settingPath: `${basePath}.*.url`,
        message: 'Amp hard-stop: remote MCP URL can select external tool-server authority.'
      }));

      const url = serverConfig.url;
      if (typeof url === 'string') {
        for (const envName of extractEnvSubstitutions(url)) {
          issues.push(issue({
            code: 'mcp-server-url-env-substitution',
            origin,
            originLabel,
            settingPath: `${basePath}.*.url`,
            envName,
            message: `Amp hard-stop: MCP URL references ${envName} from the inherited environment.`
          }));
        }
      }
    }
  }
}

function inspectMcpValueSubstitutions(
  value: unknown,
  origin: AmpConfigOriginKind,
  originLabel: string,
  issues: AmpHardStopIssue[],
  settingPath: string
): void {
  if (typeof value === 'string') {
    for (const envName of extractEnvSubstitutions(value)) {
      issues.push(issue({
        code: 'settings-env-substitution',
        origin,
        originLabel,
        settingPath,
        envName,
        message: `Amp hard-stop: ${settingPath} references ${envName} from the inherited environment.`
      }));
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const child of value) inspectMcpValueSubstitutions(child, origin, originLabel, issues, `${settingPath}.*`);
    return;
  }

  if (isRecord(value)) {
    for (const child of Object.values(value)) inspectMcpValueSubstitutions(child, origin, originLabel, issues, `${settingPath}.*`);
  }
}

function readSetting(root: JsonObject, dottedPath: string): unknown {
  if (hasOwn(root, dottedPath)) return root[dottedPath];

  const parts = dottedPath.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current) || !hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function parseJsoncObject(raw: string): { ok: true; value: JsonObject } | { ok: false } {
  try {
    const stripped = stripJsonCommentsAndTrailingCommas(raw);
    if (stripped == null) return { ok: false };
    const parsed = JSON.parse(stripped) as unknown;
    if (!isRecord(parsed)) return { ok: false };
    return { ok: true, value: parsed };
  } catch {
    return { ok: false };
  }
}

function stripJsonCommentsAndTrailingCommas(raw: string): string | null {
  const noComments = stripJsonComments(raw);
  if (noComments == null) return null;
  return stripTrailingCommas(noComments);
}

function stripJsonComments(raw: string): string | null {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    const next = raw[i + 1];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      let closed = false;
      while (i < raw.length) {
        if (raw[i] === '*' && raw[i + 1] === '/') {
          closed = true;
          i += 1;
          break;
        }
        out += raw[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (!closed) return null;
      continue;
    }

    out += ch;
  }

  return out;
}

function stripTrailingCommas(raw: string): string {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];

    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }

    if (ch === ',') {
      let j = i + 1;
      while (j < raw.length && /\s/.test(raw[j])) j += 1;
      if (raw[j] === '}' || raw[j] === ']') continue;
    }

    out += ch;
  }

  return out;
}

function extractEnvSubstitutions(value: string): string[] {
  const names = new Set<string>();
  for (const match of value.matchAll(ENV_SUBSTITUTION_RE)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

function dedupeIssues(issues: readonly AmpHardStopIssue[]): AmpHardStopIssue[] {
  const seen = new Set<string>();
  const out: AmpHardStopIssue[] = [];
  for (const hardStop of issues) {
    const key = [
      hardStop.code,
      hardStop.origin,
      hardStop.originLabel ?? '',
      hardStop.flag ?? '',
      hardStop.settingPath ?? '',
      hardStop.envName ?? ''
    ].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(hardStop);
  }
  return out;
}

function issue(issue: AmpHardStopIssue): AmpHardStopIssue {
  return issue;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value != null && !Array.isArray(value);
}

function hasOwn(value: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}
