# Amp config hard-stop matrix (2026-06-15)

## Summary

This PR adds an **internal, pure Amp config hard-stop matrix**. It is an executable safety contract for future Amp command-scoped support, but it does **not** enable Amp product support.

Still blocked after this PR:

- `amp` builtin CLI definition.
- `mat exec amp`.
- `mat session run amp`.
- `mat session start amp`.
- Public env-secret runtime injection.
- Linux Secret Service runtime injection for Amp.
- Plugin runtime injection for `type: 'env-secret'`.
- Local `amp login` capture, detection, recapture, or account binding.

## RALPLAN consensus result

- Planner decision: choose an internal pure analyzer with tests and docs, not a docs-only matrix and not hidden product wiring.
- Architect R1/R2: **ITERATE** — preserve metadata-only path boundaries, avoid local login storage overreach, treat `~/.amp/oauth/` as MCP OAuth state only, and include `amp.mcpPermissions`.
- Architect R3: **APPROVE** — R2 coverage and product-boundary constraints are reflected.
- Critic R1: **APPROVE** — acceptance criteria, verification, and product-boundary tests are concrete.

## Official docs recheck

Rechecked on 2026-06-15:

- Amp Owner's Manual: <https://ampcode.com/manual>
- Amp SDK documentation: <https://ampcode.com/manual/sdk>

Relevant public contract used for this matrix:

- The SDK docs describe `AMP_API_KEY` as the non-interactive access-token environment path and `amp login` as the local CLI login path.
- Amp reads user settings from `~/.config/amp/settings.json{,c}` on macOS/Linux, the Windows equivalent under `%USERPROFILE%`, or a custom `--settings-file`.
- Amp reads workspace settings from the nearest `.amp/settings.json{,c}` and workspace settings override user settings.
- MCP server config can include local `command` / `args` / `env`, remote `url` / `headers`, and `${VAR_NAME}` substitutions.
- MCP loading precedence is `--mcp-config`, then user/workspace `amp.mcpServers`, then skills.
- Workspace MCP servers require explicit approval; global settings and `--mcp-config` do not have the same approval requirement.
- Remote MCP OAuth tokens are stored under `~/.amp/oauth/` and are tool-server OAuth state, not primary Amp account material.
- Plugins can add tools/commands and customize behavior.
- Managed settings can override user/workspace settings from OS-level managed paths.
- `amp.mcpPermissions`, `amp.permissions`, `amp.guardedFiles`, and `amp.dangerouslyAllowAll` affect tool/MCP execution policy and are therefore preflight hard-stop surfaces for account isolation.

## Implementation

The internal helper lives at `src/core/amp-config-hard-stop.ts`.

It exports deterministic, metadata-only functions:

- `inspectAmpArgv(args)` — finds `--settings-file` and `--mcp-config` forms.
- `inspectAmpEnvironment(env)` — finds inherited `AMP_API_KEY` conflicts by name only.
- `inspectAmpSettingsText({ text, origin, originLabel })` — parses synthetic JSON/JSONC settings text and returns hard-stop issue objects.
- `plannedAmpConfigCandidates({ platform })` — returns documented path templates only, never expanded host paths.
- `formatAmpHardStopIssues(issues)` — renders metadata-only issue summaries.

The helper does not read files, inspect `process.env`, spawn processes, call Amp, instantiate env-secret backends, or import product command surfaces.

## Hard-stop matrix

| Surface | Detection in this PR | Why it hard-stops |
| --- | --- | --- |
| Inherited `AMP_API_KEY` | `inspectAmpEnvironment` reports `ambient-amp-api-key`. | Ambient env is not proven profile-owned and can override future child-process identity. |
| `--settings-file` | `inspectAmpArgv` reports `settings-file-arg`. | It can redirect Amp to arbitrary user settings outside a future profile boundary. |
| `--mcp-config` | `inspectAmpArgv` reports `mcp-config-arg`; direct MCP maps are inspectable with origin `mcp-config`. | It has highest MCP precedence and does not share workspace approval semantics. |
| User settings | `plannedAmpConfigCandidates` returns `~/.config/amp/settings.json{,c}` / Windows template. | Future product preflight must not silently inherit account-affecting global settings. |
| Workspace settings | Candidate template plus `workspace-settings-present` for any inspected workspace settings text. | Workspace settings override user settings and can be project-controlled. |
| Managed settings | Candidate template plus `managed-settings-present`. | Managed settings override user/workspace settings. |
| Local MCP `command` | `mcp-server-local-command`. | Can execute tools outside the profile boundary. |
| Local MCP `args` | `mcp-server-local-args`. | Can alter local tool execution. |
| MCP `env` | `mcp-server-env`, env names only. | Can introduce credential/provider side channels. |
| Remote MCP `url` | `mcp-server-url`. | Selects external tool-server authority. |
| Remote MCP `headers` | `mcp-server-header`. | Can carry credential material. |
| `${VAR_NAME}` substitutions | `mcp-server-url-env-substitution` or `settings-env-substitution`, env names only. | Reads inherited env outside profile ownership. |
| Plugins | `plugin-config`. | Plugins can add executable commands/tools and customize behavior. |
| MCP/tool permission policy | `mcp-permission-override`, `permission-override`, `dangerously-allow-all`. | Permission settings can alter tool execution safety. |
| MCP OAuth state | Candidate template `~/.amp/oauth/` and optional `mcp-oauth-state`. | Remote MCP OAuth tokens are tool-server state, not Amp account credentials. |
| Malformed settings | `malformed-settings`. | Unknown config cannot be classified safely; fail closed. |

## Metadata-only contract

Hard-stop issue objects may contain:

- `code`,
- symbolic `origin` / `originLabel`,
- flag names,
- settings key paths,
- environment variable names.

They must not contain:

- secret values,
- setting values,
- token-shaped examples,
- hashes or fingerprints,
- child stdout/stderr,
- expanded host/user paths,
- real Amp command output.

## Product boundary

This PR intentionally does not import the helper from product command surfaces. Tests scan source files so that:

- `BUILTIN_CLI_DEFS` still does not contain `amp`,
- no product source imports `amp-config-hard-stop`,
- no product source imports `env-secret-command-runtime` outside its internal helper,
- no Amp path instantiates `createLssEnvBackend`,
- changed code fixtures remain token-shape free.

## Acceptance criteria

- Analyzer functions are pure and deterministic.
- `--settings-file`, `--mcp-config`, inherited `AMP_API_KEY`, settings/MCP/plugin/permission surfaces, and malformed settings all fail closed.
- Findings are metadata-only and use path templates rather than expanded paths.
- Tests prove no secret-like fixture value appears in issue objects or formatted messages.
- Docs state Amp remains blocked after this PR.

## Verification

Recommended PR validation:

```bash
npm run typecheck
npx vitest run tests/core/amp-config-hard-stop.test.ts tests/core/cli-defs.test.ts tests/core/env-secret-command-runtime.test.ts tests/core/session.test.ts tests/core/exec.test.ts
npm test
npm run build:docs
git diff --check
```

Also run source allow-list scans and added-line token-shape scans before merge.

## Future unblock order

1. Recheck official Amp docs before any product wiring PR.
2. Separately RALPLAN env-secret product runtime wiring for `mat exec` / `mat session run`.
3. Wire the Amp hard-stop analyzer only in a future PR that also proves command-scoped env-secret injection, ambient conflict behavior, and no config/MCP/plugin bypasses.
4. Decide whether local `amp login` can ever be supported. Until an upstream-documented storage/redirect/recapture contract exists, do not capture, recapture, or infer it.
