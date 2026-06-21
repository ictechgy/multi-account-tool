/**
 * Support/explain registry.
 *
 * This module is intentionally read-only: it explains mat's support boundary from
 * static metadata plus `CliDef` execution metadata. It must not inspect profiles,
 * credential contents, live sources, or invoke upstream CLIs.
 */

import { BUILTIN_CLI_DEFS, findCliDef } from './cli-defs.js';
import { isEnvSecretSource } from './env-secret-source.js';
import { UnknownCliError, redactMessage } from './errors.js';
import { BUILTIN_FRESHNESS_ADAPTER_IDS } from './freshness-adapters/index.js';
import { identityCapabilitiesForCli } from './profile-identity.js';
import { isWindowsCredentialSource } from './windows-credential-source.js';
import type { CliDef, Source } from './types.js';
import type { ProfileIdentityCapability } from './profile-identity.js';

export type SupportStatus = 'supported' | 'partial' | 'experimental' | 'unsupported' | 'blocked' | 'unknown';
export type CliSupportKind = 'builtin' | 'plugin' | 'known-blocked';

export interface SupportCapability {
  status: SupportStatus;
  summary: string;
  reasons: string[];
  caveats: string[];
}

export interface DriftContract {
  id: string;
  summary: string;
  lastVerified: string;
  evidence: string[];
  risks: string[];
}

export interface CliSupportReport {
  schemaVersion: 1;
  cli: {
    id: string;
    name: string;
    builtin: boolean;
    kind: CliSupportKind;
  };
  capabilities: {
    swap: SupportCapability;
    freshness: SupportCapability;
    sessionStart: SupportCapability;
    sessionRun: SupportCapability;
  };
  sources: Array<{ type: Source['type']; saveAs: string }>;
  profileIdentity: ProfileIdentityCapability;
  ambientRisks: string[];
  driftContracts: DriftContract[];
  nextSteps: string[];
}

export interface DoctorSessionSupport {
  start: 'supported' | 'unsupported' | 'experimental';
  run: SupportStatus;
}

type CapabilityName = keyof CliSupportReport['capabilities'];

interface CapabilityOverride {
  status?: SupportStatus;
  summary?: string;
  reasons?: string[];
  caveats?: string[];
}

interface SupportMetadata {
  capabilities?: Partial<Record<CapabilityName, CapabilityOverride>>;
  ambientRisks?: string[];
  driftContracts?: DriftContract[];
  nextSteps?: string[];
}

const SCHEMA_VERSION = 1 as const;
const ADAPTER_BACKED_FRESHNESS = new Set<string>(BUILTIN_FRESHNESS_ADAPTER_IDS);
const BUILTIN_IDS = new Set(BUILTIN_CLI_DEFS.map((cli) => cli.id));

const REGISTRY: Record<string, SupportMetadata> = {
  claude: {
    capabilities: {
      sessionStart: {
        caveats: [
          'macOS stores Claude credentials in Keychain, so session isolation is blocked there; file-source platforms can use CLAUDE_CONFIG_DIR.'
        ]
      },
      sessionRun: {
        caveats: [
          'Command-scoped run uses the same session materialization boundary as session start.'
        ]
      }
    },
    ambientRisks: [
      'CLAUDE_CODE_OAUTH_TOKEN and Anthropic API-key env vars can bypass mat-selected profile state.'
    ],
    driftContracts: [
      {
        id: 'claude-credential-store',
        summary: 'Claude Code uses macOS Keychain on macOS and ~/.claude/.credentials.json on file-source platforms.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs claudeSource()', 'README Platform support'],
        risks: ['CLAUDE_CONFIG_DIR is an upstream behavior assumption and may change.']
      }
    ]
  },
  codex: {
    ambientRisks: [
      'OPENAI_API_KEY can bypass OAuth profile state; CODEX_HOME can redirect the whole Codex home.'
    ],
    driftContracts: [
      {
        id: 'codex-home-auth',
        summary: 'Codex auth lives in ~/.codex/auth.json and CODEX_HOME relocates the Codex home.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs Codex session root', 'PR #93 copy-isolated skills/config'],
        risks: ['New Codex config or plugin write paths may need explicit copy-isolate review.']
      }
    ]
  },
  gemini: {
    ambientRisks: [
      'GEMINI_API_KEY, GOOGLE_API_KEY, and Google Cloud env vars can select credentials outside mat profiles.'
    ],
    driftContracts: [
      {
        id: 'gemini-cli-home',
        summary: 'GEMINI_CLI_HOME points to the parent of .gemini; mat uses envSubdir=.gemini.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs Gemini session comments', 'README Platform support'],
        risks: ['Google CLI home semantics can drift; keep envSubdir tests in sync.']
      }
    ]
  },
  aider: {
    capabilities: {
      freshness: {
        status: 'partial',
        summary: 'Fallback byte-diff only; no adapter-backed identity/rotation contract.'
      },
      sessionStart: {
        status: 'unsupported',
        summary: 'No safe credential-directory env root for interactive session start.',
        reasons: ['Aider credentials can come from env vars, argv, dotenv, project config, and provider chains.']
      },
      sessionRun: {
        status: 'partial',
        summary: 'Command-scoped safer run with forced --config/--env-file and hard-stop bypass checks.',
        reasons: ['mat owns the builtin executable argv boundary but does not claim full Aider home isolation.']
      }
    },
    ambientRisks: [
      'AIDER_* env vars, provider API-key env vars, .env files, and model sidecar files can bypass mat unless session run hard-stops them.'
    ],
    driftContracts: [
      {
        id: 'aider-command-boundary',
        summary: 'Aider support is command-scoped partial support, not session-start/home isolation.',
        lastVerified: '2026-06-14',
        evidence: ['session preflightAiderSessionRun', 'README session run Aider caveat'],
        risks: ['New Aider argv/env credential channels require hard-stop updates.']
      }
    ]
  },
  kimi: {
    capabilities: {
      freshness: {
        status: 'partial',
        summary: 'Fallback byte-diff only; no adapter-backed identity/rotation contract.'
      }
    },
    ambientRisks: [
      'MOONSHOT_API_KEY and KIMI_API_KEY env vars can bypass ~/.kimi/config.toml.'
    ],
    driftContracts: [
      {
        id: 'kimi-share-dir',
        summary: 'KIMI_SHARE_DIR relocates ~/.kimi for file-based session isolation.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs Kimi session root'],
        risks: ['Single config file mixes credentials and config; session changes are ephemeral.']
      }
    ]
  },
  qwen: {
    capabilities: {
      freshness: {
        status: 'partial',
        summary: 'Fallback byte-diff only; no adapter-backed identity/rotation contract.'
      }
    },
    ambientRisks: [
      'DASHSCOPE_API_KEY, QWEN_API_KEY, OPENAI_API_KEY, ~/.qwen/.env, and project .env can override swapped settings.'
    ],
    driftContracts: [
      {
        id: 'qwen-home-precedence',
        summary: 'QWEN_HOME relocates ~/.qwen, but shell env and dotenv precedence can bypass swapped files.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs Qwen comments', 'README Platform support'],
        risks: ['Provider precedence changes can create new ambient bypasses.']
      }
    ]
  },
  crush: {
    capabilities: {
      freshness: {
        status: 'partial',
        summary: 'Fallback byte-diff only; no adapter-backed identity/rotation contract.'
      }
    },
    ambientRisks: [
      'CRUSH_GLOBAL_CONFIG, CRUSH_GLOBAL_DATA, provider env vars, and project-local crush.json files can bypass mat defaults.'
    ],
    driftContracts: [
      {
        id: 'crush-xdg-roots',
        summary: 'Crush uses separate config/data roots that mat relocates with CRUSH_GLOBAL_CONFIG and CRUSH_GLOBAL_DATA.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs Crush session roots', 'README Platform support'],
        risks: ['Project-local config precedence remains outside mat scope.']
      }
    ]
  },
  opencode: {
    capabilities: {
      sessionStart: {
        status: 'experimental',
        summary: 'Session start works by redirecting broad XDG_DATA_HOME, which can affect other XDG-aware tools.',
        reasons: ['OpenCode lacks a CLI-specific data-home override.']
      },
      sessionRun: {
        status: 'partial',
        summary: 'Command-scoped safer run with known env/config bypass hard-stops; XDG_DATA_HOME remains broad.'
      }
    },
    ambientRisks: [
      'OPENCODE_AUTH_CONTENT, OPENCODE_CONFIG_DIR, OPENCODE_CONFIG(_CONTENT), project opencode.json, and env-referenced apiKey values can bypass mat.'
    ],
    driftContracts: [
      {
        id: 'opencode-xdg-data',
        summary: 'OpenCode auth.json is under XDG data root; mat uses XDG_DATA_HOME with envSubdir=opencode.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs opencodeDataRoot()', 'README Platform support'],
        risks: ['Broad XDG_DATA_HOME can redirect unrelated tools in a session.']
      }
    ]
  },
  goose: {
    ambientRisks: [
      'GOOSE_DISABLE_KEYRING changes backend selection; GOOSE_PROVIDER/model and provider env vars can bypass profile intent.'
    ],
    driftContracts: [
      {
        id: 'goose-keyring-backend',
        summary: 'Goose defaults to Keychain/Secret Service plus YAML config; GOOSE_DISABLE_KEYRING switches to file backend.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs gooseSources()', 'README Goose Linux notes'],
        risks: ['Missing secret-tool does not prove Goose is not using libsecret; backend assumptions must stay fail-closed.']
      }
    ]
  },
  grok: {
    capabilities: {
      freshness: {
        status: 'partial',
        summary: 'Fallback byte-diff only; no adapter-backed Grok identity/rotation contract.'
      },
      sessionStart: {
        status: 'unsupported',
        summary: 'Interactive session start is unsupported in PR1; Grok support is limited to auth.json profile swap.',
        reasons: ['Grok config/env/project-local/MCP credential channels can bypass auth.json and need a separate session isolation design.']
      },
      sessionRun: {
        status: 'unsupported',
        summary: 'Command-scoped session run is unsupported in PR1; no builtin executable boundary is enabled.'
      }
    },
    ambientRisks: [
      '~/.grok/config.toml model api_key/env_key entries can outrank the signed-in auth.json token.',
      'XAI_API_KEY, GROK_HOME, GROK_AUTH_*, GROK_OIDC_*, GROK_MODELS_*, and project .grok/config.toml are outside PR1 profile swap scope.',
      'MCP credentials, headers, hooks, and project-local Grok config can select credentials independently of mat-selected auth.json.'
    ],
    driftContracts: [
      {
        id: 'grok-auth-json-pr1',
        summary: 'Grok PR1 support swaps only the primary signed-in credential file ~/.grok/auth.json.',
        lastVerified: '2026-06-20',
        evidence: ['cli-defs grok builtin source', 'Grok builtin PR1 plan/test spec'],
        risks: ['Config/env/project-local credential overrides can cause Grok to use a different account than the swapped auth.json.']
      }
    ],
    nextSteps: [
      'Use the TUI profile switch only for Grok browser/OIDC auth.json account switching (select `grok`, then the target profile).',
      'Unset XAI_API_KEY/GROK_* overrides and review ~/.grok/config.toml or project .grok/config.toml before relying on the selected profile.',
      'Do not use `mat session run grok` until a future explicit session-isolation PR lands.'
    ]
  }
};

const KNOWN_BLOCKED: Record<string, { name: string; metadata: SupportMetadata }> = {
  agy: {
    name: 'Google Antigravity',
    metadata: {
      capabilities: {
        swap: {
          status: 'blocked',
          summary: 'Blocked: no stable documented credential source contract for mat to swap.'
        },
        freshness: {
          status: 'blocked',
          summary: 'Blocked until a stable credential store/profile contract exists.'
        },
        sessionStart: {
          status: 'blocked',
          summary: 'Blocked: safe probes found no CLI-specific credential/data redirect; broad HOME redirect is too risky.'
        },
        sessionRun: {
          status: 'blocked',
          summary: 'Blocked: command-scoped isolation still lacks a trusted credential boundary.'
        }
      },
      ambientRisks: [
        'Antigravity documents system-keyring authentication, but not a stable service/account, token profile, or redirect contract for mat to swap.',
        'Files under ~/.gemini/antigravity-cli/ are settings/cache evidence, not a credential boundary.'
      ],
      driftContracts: [
        {
          id: 'agy-blocked-no-contract',
          summary: 'Antigravity remains blocked: public docs describe system keyring + Google Sign-In fallback, not a stable mat-safe auth-store or redirect contract.',
          lastVerified: '2026-06-14',
          evidence: [
            'google-antigravity/antigravity-cli README: system keyring auth + Google Sign-In fallback; /logout sign-out only',
            'google-antigravity/antigravity-cli CHANGELOG: latest observed release 1.0.8 on 2026-06-12',
            'local agy --version: 1.0.8; agy --help exposes no auth-store redirect flag/subcommand',
            'docs/superpowers/specs/2026-06-14-antigravity-auth-store-research.md'
          ],
          risks: [
            'Treating Gemini CLI files or Antigravity cache files as credentials can cause wrong-account behavior.',
            'Local keyring discoveries are not a stable upstream compatibility contract.'
          ]
        }
      ],
      nextSteps: [
        'Use the upstream Antigravity account switcher/auth flow directly.',
        'Revisit mat support only after upstream documents a stable credential-store contract plus safe redirect and recapture behavior.'
      ]
    }
  }
};

function cap(status: SupportStatus, summary: string, reasons: string[] = [], caveats: string[] = []): SupportCapability {
  return {
    status,
    summary: redactMessage(summary),
    reasons: reasons.map(redactMessage),
    caveats: caveats.map(redactMessage)
  };
}

function mergeCapability(base: SupportCapability, override: CapabilityOverride | undefined): SupportCapability {
  if (!override) return base;
  return cap(
    override.status ?? base.status,
    override.summary ?? base.summary,
    [...base.reasons, ...(override.reasons ?? [])],
    [...base.caveats, ...(override.caveats ?? [])]
  );
}

function sourceSummary(def: CliDef): Array<{ type: Source['type']; saveAs: string }> {
  return def.sources.map((src) => ({ type: src.type, saveAs: redactMessage(src.saveAs) }));
}

function deriveSwap(def: CliDef): SupportCapability {
  if (def.sources.some(isEnvSecretSource)) {
    return cap(
      'blocked',
      'Profile swap is blocked because env-secret sources are accepted only as metadata.',
      ['env-secret product storage and restore semantics are not enabled.']
    );
  }
  if (def.sources.some(isWindowsCredentialSource)) {
    if (process.platform !== 'win32') {
      return cap(
        'blocked',
        'Profile swap is blocked because win-credential sources require a Windows runtime.',
        ['win-credential is a Windows Credential Manager primitive; non-win32 hosts must not treat it as missing.']
      );
    }
    return cap(
      'partial',
      'Profile swap can use the win-credential source primitive on Windows, but full package/builtin Windows support is not claimed.',
      ['This PR enables the source primitive/preflight path only; builtins and package-level win32 support remain blocked.'],
      ['User plugins must supply exact target/account metadata and handle upstream Windows credential contracts.']
    );
  }
  return cap('supported', `Profile swap is supported for ${def.sources.length} configured source(s).`);
}

function deriveFreshness(def: CliDef): SupportCapability {
  if (def.sources.some(isEnvSecretSource)) {
    return cap(
      'blocked',
      'Freshness is metadata-only blocked for env-secret sources.',
      ['env-secret values must not be read or compared through freshness.']
    );
  }
  if (def.sources.some(isWindowsCredentialSource)) {
    if (process.platform !== 'win32') {
      return cap(
        'blocked',
        'Freshness is blocked because win-credential sources require a Windows runtime.',
        ['non-win32 hosts report win-credential as unsupported instead of reading or probing it.']
      );
    }
    return cap(
      'partial',
      'Fallback byte-diff freshness can read win-credential sources on Windows, but no adapter-backed identity contract is registered.',
      ['The win-credential primitive preserves account metadata guards but does not prove upstream CLI identity semantics.']
    );
  }
  if (ADAPTER_BACKED_FRESHNESS.has(def.id)) {
    return cap('supported', 'Adapter-backed freshness check is available for identity/rotation-aware drift classification.');
  }
  return cap(
    'partial',
    'Fallback byte-diff freshness is available, but no adapter-backed identity/rotation contract is registered.',
    ['Fallback confidence is low and cannot always distinguish safe rotation from identity changes.']
  );
}

function deriveSessionStart(def: CliDef): SupportCapability {
  if (!def.session || def.session.roots.length === 0) {
    return cap('unsupported', 'Interactive session start is unsupported because no session env root is defined.');
  }
  const nonFileSources = def.sources.filter((src) => src.type !== 'file');
  if (nonFileSources.length > 0) {
    return cap(
      'blocked',
      'Interactive session start is blocked because at least one credential source is not file-based.',
      [`Non-file source type(s): ${Array.from(new Set(nonFileSources.map((src) => src.type))).join(', ')}`]
    );
  }
  if (def.session.roots.some((root) => /EXPERIMENTAL/i.test(root.warning ?? ''))) {
    return cap('experimental', 'Interactive session start is available but marked experimental by its session root warning.');
  }
  return cap('supported', 'Interactive session start is supported through CLI-specific env root isolation.');
}

function deriveSessionRun(def: CliDef, start: SupportCapability): SupportCapability {
  if (!def.sessionRun) return cap('unsupported', 'Command-scoped session run is unsupported because no builtin executable is defined.');
  if (start.status === 'blocked') {
    return cap('blocked', 'Command-scoped session run is blocked by the same non-file source boundary as session start.', start.reasons);
  }
  if (start.status === 'unsupported' && def.id !== 'aider') {
    return cap('unsupported', 'Command-scoped session run requires a session env root for this CLI.');
  }
  return cap('supported', 'Command-scoped session run is supported for the builtin executable.');
}

function defaultNextSteps(cliId: string, caps: CliSupportReport['capabilities']): string[] {
  const steps = ['Run `mat doctor --json` for local profile/source diagnostics.'];
  if (caps.freshness.status === 'supported' || caps.freshness.status === 'partial') {
    steps.push(`Run \`mat freshness ${cliId}\` before risky swaps or automation.`);
  }
  if (caps.sessionStart.status === 'supported' || caps.sessionStart.status === 'experimental') {
    steps.push(`Use \`mat session start ${cliId} <profile>\` for concurrent isolated sessions.`);
  }
  if (caps.sessionRun.status === 'supported' || caps.sessionRun.status === 'partial' || caps.sessionRun.status === 'experimental') {
    steps.push(`Use \`mat session run ${cliId} <profile> -- [args...]\` for command-scoped isolation.`);
  }
  return steps;
}

function buildFromCliDef(def: CliDef, kind: 'builtin' | 'plugin'): CliSupportReport {
  const metadata: SupportMetadata = kind === 'builtin' ? (REGISTRY[def.id] ?? {}) : pluginMetadata();
  const hasEnvSecret = def.sources.some(isEnvSecretSource);
  const hasWindowsCredential = def.sources.some(isWindowsCredentialSource);
  const start = mergeCapability(deriveSessionStart(def), metadata.capabilities?.sessionStart);
  const baseCaps = {
    swap: deriveSwap(def),
    freshness: deriveFreshness(def),
    sessionStart: start,
    sessionRun: deriveSessionRun(def, start)
  };
  const capabilities = {
    swap: mergeCapability(baseCaps.swap, metadata.capabilities?.swap),
    freshness: mergeCapability(baseCaps.freshness, metadata.capabilities?.freshness),
    sessionStart: start,
    sessionRun: mergeCapability(baseCaps.sessionRun, metadata.capabilities?.sessionRun)
  };
  if (hasEnvSecret) {
    capabilities.swap = baseCaps.swap;
    capabilities.freshness = baseCaps.freshness;
  }
  if (hasWindowsCredential) {
    capabilities.swap = baseCaps.swap;
    capabilities.freshness = baseCaps.freshness;
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    cli: { id: def.id, name: redactMessage(def.name), builtin: kind === 'builtin', kind },
    capabilities,
    sources: sourceSummary(def),
    profileIdentity: identityCapabilitiesForCli(kind === 'builtin' ? def.id : 'plugin'),
    ambientRisks: (metadata.ambientRisks ?? []).map(redactMessage),
    driftContracts: (metadata.driftContracts ?? []).map(redactDriftContract),
    nextSteps: (metadata.nextSteps ?? defaultNextSteps(def.id, capabilities)).map(redactMessage)
  };
}

function pluginMetadata(): SupportMetadata {
  return {
    capabilities: {
      freshness: {
        status: 'partial',
        summary: 'Fallback byte-diff only; plugins cannot register an adapter-backed identity/rotation contract.'
      },
      sessionStart: {
        status: 'unsupported',
        summary: 'User plugin CLIs are profile-swap only and cannot define trusted session env roots.'
      },
      sessionRun: {
        status: 'unsupported',
        summary: 'User plugin CLIs cannot define builtin session-run executables.'
      }
    },
    ambientRisks: [
      'Plugin support is limited to source swap metadata supplied by the user; mat cannot know upstream ambient env/project override channels.'
    ],
    driftContracts: [
      {
        id: 'plugin-swap-only',
        summary: 'Plugin CLI definitions are intentionally limited to id/name/sources.',
        lastVerified: '2026-06-14',
        evidence: ['cli-defs-plugin.validateCliDefRaw drops session/sessionRun fields'],
        risks: ['Plugin authors must document their own upstream credential precedence and ambient bypasses.']
      }
    ]
  };
}

function buildKnownBlocked(id: string, entry: { name: string; metadata: SupportMetadata }): CliSupportReport {
  const metadata = entry.metadata;
  const blocked = cap('blocked', 'Blocked: no supported mat integration contract is available.');
  const capabilities = {
    swap: mergeCapability(blocked, metadata.capabilities?.swap),
    freshness: mergeCapability(blocked, metadata.capabilities?.freshness),
    sessionStart: mergeCapability(blocked, metadata.capabilities?.sessionStart),
    sessionRun: mergeCapability(blocked, metadata.capabilities?.sessionRun)
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    cli: { id, name: redactMessage(entry.name), builtin: false, kind: 'known-blocked' },
    capabilities,
    sources: [],
    profileIdentity: identityCapabilitiesForCli(id),
    ambientRisks: (metadata.ambientRisks ?? []).map(redactMessage),
    driftContracts: (metadata.driftContracts ?? []).map(redactDriftContract),
    nextSteps: (metadata.nextSteps ?? []).map(redactMessage)
  };
}

function redactDriftContract(contract: DriftContract): DriftContract {
  return {
    id: redactMessage(contract.id),
    summary: redactMessage(contract.summary),
    lastVerified: contract.lastVerified,
    evidence: contract.evidence.map(redactMessage),
    risks: contract.risks.map(redactMessage)
  };
}

export function buildCliSupportReport(cliId: string): CliSupportReport {
  const builtin = BUILTIN_CLI_DEFS.find((def) => def.id === cliId);
  if (builtin) return buildFromCliDef(builtin, 'builtin');
  const known = KNOWN_BLOCKED[cliId];
  if (known) return buildKnownBlocked(cliId, known);
  const def = findCliDef(cliId);
  if (def) return buildFromCliDef(def, 'plugin');
  throw new UnknownCliError(cliId);
}

function doctorStartStatus(status: SupportStatus): DoctorSessionSupport['start'] {
  if (status === 'supported') return 'supported';
  if (status === 'partial' || status === 'experimental') return 'experimental';
  return 'unsupported';
}

export function doctorSessionSupportForCli(cli: CliDef): DoctorSessionSupport {
  const report = buildFromCliDef(cli, BUILTIN_IDS.has(cli.id) ? 'builtin' : 'plugin');
  return {
    start: doctorStartStatus(report.capabilities.sessionStart.status),
    run: report.capabilities.sessionRun.status
  };
}

function statusLabel(status: SupportStatus): string {
  switch (status) {
    case 'supported': return 'supported';
    case 'partial': return 'partial';
    case 'experimental': return 'experimental';
    case 'unsupported': return 'unsupported';
    case 'blocked': return 'blocked';
    case 'unknown': return 'unknown';
    default: {
      const neverStatus: never = status;
      return neverStatus;
    }
  }
}

function capabilityLines(label: string, item: SupportCapability): string[] {
  const lines = [`  ${label}: ${statusLabel(item.status)} — ${item.summary}`];
  for (const reason of item.reasons) lines.push(`    reason: ${reason}`);
  for (const caveat of item.caveats) lines.push(`    caveat: ${caveat}`);
  return lines;
}

export function formatSupportReport(report: CliSupportReport): string {
  const lines: string[] = [];
  lines.push(`mat support — ${report.cli.id} (${report.cli.name})`);
  lines.push(`kind: ${report.cli.kind}`);
  lines.push('');
  lines.push('Capabilities:');
  lines.push(...capabilityLines('swap', report.capabilities.swap));
  lines.push(...capabilityLines('freshness', report.capabilities.freshness));
  lines.push(...capabilityLines('session start', report.capabilities.sessionStart));
  lines.push(...capabilityLines('session run', report.capabilities.sessionRun));
  lines.push('');
  lines.push('Sources:');
  if (report.sources.length === 0) {
    lines.push('  (none)');
  } else {
    for (const src of report.sources) lines.push(`  - ${src.saveAs} [${src.type}]`);
  }
  lines.push('');
  lines.push(`Profile identity: ${report.profileIdentity.status}`);
  if (report.profileIdentity.signals.length === 0) {
    lines.push('  (no static identity signals)');
  } else {
    for (const sig of report.profileIdentity.signals) {
      lines.push(`  - ${sig.kind} from ${sig.source} (${sig.safety})`);
    }
  }
  if (report.ambientRisks.length > 0) {
    lines.push('');
    lines.push('Ambient/project risks:');
    for (const risk of report.ambientRisks) lines.push(`  - ${risk}`);
  }
  if (report.driftContracts.length > 0) {
    lines.push('');
    lines.push('Drift contracts:');
    for (const contract of report.driftContracts) {
      lines.push(`  - ${contract.id} (${contract.lastVerified}): ${contract.summary}`);
      for (const risk of contract.risks) lines.push(`    risk: ${risk}`);
    }
  }
  if (report.nextSteps.length > 0) {
    lines.push('');
    lines.push('Next steps:');
    for (const step of report.nextSteps) lines.push(`  - ${step}`);
  }
  return `${lines.join('\n')}\n`;
}
