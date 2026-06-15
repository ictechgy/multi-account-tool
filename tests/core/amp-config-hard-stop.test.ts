import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BUILTIN_CLI_DEFS } from '../../src/core/cli-defs.js';
import {
  formatAmpHardStopIssues,
  inspectAmpArgv,
  inspectAmpEnvironment,
  inspectAmpSettingsText,
  plannedAmpConfigCandidates,
  type AmpHardStopIssue
} from '../../src/core/amp-config-hard-stop.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sourceUrl = new URL('../../src/core/amp-config-hard-stop.ts', import.meta.url);

function codes(issues: readonly AmpHardStopIssue[]): string[] {
  return issues.map((issue) => issue.code);
}

describe('Amp config hard-stop matrix safety gate', () => {
  it('hard-stops Amp settings and MCP redirect argv without echoing values', () => {
    const issues = inspectAmpArgv([
      'run',
      '--settings-file',
      '/private/fixture/settings.json',
      '--settings-file=/private/fixture/other.json',
      '--mcp-config',
      '/private/fixture/mcp.json',
      '--mcp-config=/private/fixture/mcp-alt.json',
      '--safe-looking'
    ]);

    expect(issues).toEqual([
      expect.objectContaining({ code: 'settings-file-arg', origin: 'argv', flag: '--settings-file' }),
      expect.objectContaining({ code: 'mcp-config-arg', origin: 'argv', flag: '--mcp-config' })
    ]);

    const serialized = JSON.stringify(issues) + '\n' + formatAmpHardStopIssues(issues);
    expect(serialized).not.toContain('/private/fixture');
    expect(serialized).not.toContain('settings.json');
    expect(serialized).not.toContain('mcp-alt.json');
  });

  it('ignores unrelated argv', () => {
    expect(inspectAmpArgv(['threads', '--help', 'prompt'])).toEqual([]);
  });

  it('hard-stops inherited AMP_API_KEY by name only', () => {
    const issues = inspectAmpEnvironment({ AMP_API_KEY: 'fixture-access-value', OTHER: 'ok' });

    expect(issues).toEqual([
      expect.objectContaining({ code: 'ambient-amp-api-key', origin: 'ambient-env', envName: 'AMP_API_KEY' })
    ]);
    expect(JSON.stringify(issues) + formatAmpHardStopIssues(issues)).not.toContain('fixture-access-value');
  });

  it('detects MCP local, remote, env substitution, plugin, and permission override surfaces', () => {
    const issues = inspectAmpSettingsText({
      origin: 'user-settings',
      originLabel: 'user-settings',
      text: `{
        // JSONC comments and trailing commas are accepted for Amp settings fixtures.
        "amp.mcpServers": {
          "local-fixture": {
            "command": "fixture-bin",
            "args": ["--profile", "hidden-behavior"],
            "env": {
              "AMP_SIDE_CHANNEL": "ignored-value",
            },
          },
          "remote-fixture": {
            "url": "https://mcp.invalid/\${REMOTE_MCP_ENV}",
            "headers": {
              "Authorization": "Bearer \${REMOTE_HEADER_ENV}"
            }
          }
        },
        "amp.plugins": ["plugin-fixture"],
        "amp.permissions": { "allow": ["fixture"] },
        "amp.mcpPermissions": { "server.tool": "allow" },
        "amp.guardedFiles": { "allowlist": ["fixture.txt"] },
        "amp.dangerouslyAllowAll": true,
      }`
    });

    expect(codes(issues)).toEqual(expect.arrayContaining([
      'mcp-server-local-command',
      'mcp-server-local-args',
      'mcp-server-env',
      'mcp-server-header',
      'mcp-server-url',
      'mcp-server-url-env-substitution',
      'settings-env-substitution',
      'plugin-config',
      'permission-override',
      'mcp-permission-override',
      'dangerously-allow-all'
    ]));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'mcp-server-env', envName: 'AMP_SIDE_CHANNEL' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'mcp-server-url-env-substitution', envName: 'REMOTE_MCP_ENV' }));
    expect(issues).toContainEqual(expect.objectContaining({ code: 'settings-env-substitution', envName: 'REMOTE_HEADER_ENV' }));

    const serialized = JSON.stringify(issues) + '\n' + formatAmpHardStopIssues(issues);
    for (const forbidden of ['fixture-bin', 'hidden-behavior', 'ignored-value', 'Bearer', 'plugin-fixture', 'fixture.txt']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('hard-stops direct --mcp-config server maps', () => {
    const issues = inspectAmpSettingsText({
      origin: 'mcp-config',
      originLabel: 'mcp-config',
      text: '{ "direct-server": { "command": "node", "args": ["server.js"] } }'
    });

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-local-command',
      origin: 'mcp-config',
      settingPath: 'mcp-config.*.command'
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-local-args',
      origin: 'mcp-config',
      settingPath: 'mcp-config.*.args'
    }));
    expect(JSON.stringify(issues)).not.toContain('server.js');
  });


  it('hard-stops mixed direct --mcp-config entries even when amp.mcpServers is present', () => {
    const issues = inspectAmpSettingsText({
      origin: 'mcp-config',
      originLabel: 'mcp-config',
      text: JSON.stringify({
        safe: { command: 'node', args: ['server.js'] },
        amp: { mcpServers: {} }
      })
    });

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-local-command',
      settingPath: 'mcp-config.*.command'
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-local-args',
      settingPath: 'mcp-config.*.args'
    }));
    expect(JSON.stringify(issues)).not.toContain('server.js');
  });

  it('fails closed on uninspectable MCP server entries', () => {
    const direct = inspectAmpSettingsText({
      origin: 'mcp-config',
      originLabel: 'mcp-config',
      text: '{ "direct": "not-object" }'
    });
    const nested = inspectAmpSettingsText({
      origin: 'user-settings',
      originLabel: 'user-settings',
      text: '{ "amp.mcpServers": { "bad": "not-object" } }'
    });

    expect(direct).toContainEqual(expect.objectContaining({
      code: 'malformed-settings',
      settingPath: 'mcp-config.*'
    }));
    expect(nested).toContainEqual(expect.objectContaining({
      code: 'malformed-settings',
      settingPath: 'amp.mcpServers.*'
    }));
    expect(JSON.stringify([...direct, ...nested])).not.toContain('not-object');
  });

  it('does not leak user-controlled MCP server names or expanded paths', () => {
    const issues = inspectAmpSettingsText({
      origin: 'user-settings',
      originLabel: 'user-settings',
      text: JSON.stringify({
        'amp.mcpServers': {
          '/Users/alice/private-server': {
            headers: { Authorization: 'Bearer ${PRIVATE_HEADER_ENV}' },
            url: 'https://mcp.invalid/${PRIVATE_URL_ENV}'
          }
        }
      })
    });

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-header',
      settingPath: 'amp.mcpServers.*.headers'
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-url-env-substitution',
      settingPath: 'amp.mcpServers.*.url',
      envName: 'PRIVATE_URL_ENV'
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'settings-env-substitution',
      settingPath: 'amp.mcpServers.*.headers.*',
      envName: 'PRIVATE_HEADER_ENV'
    }));

    const serialized = JSON.stringify(issues) + '\n' + formatAmpHardStopIssues(issues);
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('private-server');
    expect(serialized).not.toContain('Bearer');
  });


  it('does not leak user-controlled direct --mcp-config server names or expanded paths', () => {
    const issues = inspectAmpSettingsText({
      origin: 'mcp-config',
      originLabel: 'mcp-config',
      text: JSON.stringify({
        '/Users/alice/direct-private-server': {
          headers: { Authorization: 'Bearer ${DIRECT_HEADER_ENV}' },
          url: 'https://mcp.invalid/${DIRECT_URL_ENV}'
        }
      })
    });

    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-header',
      settingPath: 'mcp-config.*.headers'
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'settings-env-substitution',
      settingPath: 'mcp-config.*.headers.*',
      envName: 'DIRECT_HEADER_ENV'
    }));
    expect(issues).toContainEqual(expect.objectContaining({
      code: 'mcp-server-url-env-substitution',
      settingPath: 'mcp-config.*.url',
      envName: 'DIRECT_URL_ENV'
    }));

    const serialized = JSON.stringify(issues) + '\n' + formatAmpHardStopIssues(issues);
    expect(serialized).not.toContain('/Users/alice');
    expect(serialized).not.toContain('direct-private-server');
    expect(serialized).not.toContain('Bearer');
  });

  it('treats workspace, managed, and MCP OAuth origins as hard-stop surfaces without real paths', () => {
    const workspace = inspectAmpSettingsText({ origin: 'workspace-settings', originLabel: 'workspace-settings', text: '{}' });
    const managed = inspectAmpSettingsText({ origin: 'managed-settings', originLabel: 'managed-settings', text: '{}' });
    const oauth = inspectAmpSettingsText({ origin: 'mcp-oauth', originLabel: 'mcp-oauth-state', text: '{}' });

    expect(workspace).toContainEqual(expect.objectContaining({ code: 'workspace-settings-present' }));
    expect(managed).toContainEqual(expect.objectContaining({ code: 'managed-settings-present' }));
    expect(oauth).toContainEqual(expect.objectContaining({ code: 'mcp-oauth-state' }));

    const serialized = JSON.stringify([...workspace, ...managed, ...oauth]);
    expect(serialized).not.toMatch(/\/Users\/|\/home\/|C:\\/);
    expect(serialized).toContain('tool-server state, not primary Amp account material');
  });

  it('fails closed on malformed JSON/JSONC and never echoes raw text', () => {
    const issues = inspectAmpSettingsText({
      origin: 'user-settings',
      originLabel: 'user-settings',
      text: '{ "amp.mcpServers": { "broken": { "env": { "LEAK_NAME": "hidden-config-value" } }'
    });

    expect(issues).toEqual([
      expect.objectContaining({ code: 'malformed-settings', origin: 'user-settings', originLabel: 'user-settings' })
    ]);
    expect(JSON.stringify(issues) + formatAmpHardStopIssues(issues)).not.toContain('hidden-config-value');
  });

  it('fails closed on unterminated JSONC block comments', () => {
    const issues = inspectAmpSettingsText({
      origin: 'user-settings',
      originLabel: 'user-settings',
      text: '{ } /* unterminated hidden-config-value'
    });

    expect(issues).toEqual([
      expect.objectContaining({ code: 'malformed-settings', origin: 'user-settings', originLabel: 'user-settings' })
    ]);
    expect(JSON.stringify(issues) + formatAmpHardStopIssues(issues)).not.toContain('hidden-config-value');
  });

  it('returns documented path templates only for future preflight candidates', () => {
    expect(plannedAmpConfigCandidates({ platform: 'linux' })).toEqual(expect.arrayContaining([
      { origin: 'workspace-settings', originLabel: 'workspace-settings', pathTemplate: '.amp/settings.json{,c}', mustHardStopIfExists: true },
      { origin: 'user-settings', originLabel: 'user-settings', pathTemplate: '~/.config/amp/settings.json{,c}', mustHardStopIfExists: true },
      { origin: 'managed-settings', originLabel: 'managed-settings', pathTemplate: '/etc/ampcode/managed-settings.json', mustHardStopIfExists: true },
      { origin: 'mcp-oauth', originLabel: 'mcp-oauth-state', pathTemplate: '~/.amp/oauth/', mustHardStopIfExists: true }
    ]));

    expect(plannedAmpConfigCandidates({ platform: 'darwin' })).toContainEqual(expect.objectContaining({
      origin: 'managed-settings',
      pathTemplate: '/Library/Application Support/ampcode/managed-settings.json'
    }));
    expect(plannedAmpConfigCandidates({ platform: 'win32' })).toContainEqual(expect.objectContaining({
      origin: 'user-settings',
      pathTemplate: '%USERPROFILE%\\.config\\amp\\settings.json{,c}'
    }));

    for (const candidate of plannedAmpConfigCandidates({ platform: 'win32' })) {
      expect(candidate.pathTemplate).not.toMatch(/\/Users\/|\/home\/|C:\\Users\\/);
    }
  });

  it('keeps the helper pure and outside Amp product support wiring', () => {
    const source = readFileSync(sourceUrl, 'utf8');

    expect(source).not.toMatch(/from ['"]node:(fs|os|child_process|process|http|https)['"]/);
    expect(source).not.toMatch(/\bprocess\./);
    expect(source).not.toContain('local-login');
    expect(source).not.toMatch(/prepareEnvSecretCommandEnv|createLssEnvBackend|env-secret-linux-secret-service/);
    expect(BUILTIN_CLI_DEFS.some((def) => def.id === 'amp')).toBe(false);
  });

  it('keeps source wiring allow-listed and token-shaped fixtures absent', () => {
    const sourceFiles = listFiles(join(root, 'src'), /\.(ts|tsx)$/);
    const testFiles = listFiles(join(root, 'tests'), /\.(ts|tsx|json|md)$/);
    const ampModuleMentions = [...sourceFiles, ...testFiles].filter((file) => readFileSync(file, 'utf8').includes('amp-config-hard-stop'));

    expect(ampModuleMentions.map((file) => relative(root, file).split(sep).join('/'))).toEqual([
      'tests/core/amp-config-hard-stop.test.ts'
    ]);

    for (const file of sourceFiles) {
      const rel = relative(root, file).split(sep).join('/');
      const text = readFileSync(file, 'utf8');
      if (rel === 'src/core/env-secret-command-runtime.ts') continue;
      expect({ rel, mentions: text.includes('env-secret-command-runtime') || text.includes('prepareEnvSecretCommandEnv') }).toEqual({
        rel,
        mentions: false
      });
      expect({ rel, lssAmp: text.includes('createLssEnvBackend') && /\bamp\b/i.test(text) }).toEqual({ rel, lssAmp: false });
    }

    const changedFiles = [
      'src/core/amp-config-hard-stop.ts',
      'tests/core/amp-config-hard-stop.test.ts'
    ];
    for (const rel of changedFiles) {
      const text = readFileSync(join(root, rel), 'utf8');
      expect(text, `${rel} must not contain Amp access-token shapes`).not.toMatch(/\bsgamp_[A-Za-z0-9_]{8,}/);
      expect(text, `${rel} must not contain OpenAI-like key shapes`).not.toMatch(/\bsk-[A-Za-z0-9]{12,}/);
      expect(text, `${rel} must not contain GitHub token shapes`).not.toMatch(/\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}/);
      expect(text, `${rel} must not contain JWT-like values`).not.toMatch(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./);
    }
  });
});

function listFiles(dir: string, pattern: RegExp): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, pattern));
    if (entry.isFile() && pattern.test(entry.name)) out.push(abs);
  }
  return out;
}
