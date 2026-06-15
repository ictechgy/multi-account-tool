# Copilot CLI / Amp auth-store research — blocked support note (2026-06-14)

## Summary

GitHub Copilot CLI (`copilot`) and Amp (`amp`) remain **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, and `mat session run` support.

This note is a research artifact only. It does **not** add product support.

The public evidence is enough to reject a simple builtin definition, but not enough to implement safe multi-account support:

- Copilot CLI supports multiple accounts and stores OAuth credentials through OS keychains, but the account-selection state is split from the token store. `mat` must know which upstream account a profile targets and must swap the matching application state without falling through to unrelated ambient tokens.
- Amp documents `AMP_API_KEY` for non-interactive use, `amp login` for local CLI login, user/workspace settings, and MCP OAuth state. That is not representable by the current `file` / macOS `keychain` / Linux `os-keyring` profile-swap model.

## Evidence checked

### GitHub Copilot CLI

Sources checked:

- GitHub Docs — Authenticating Copilot CLI: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- GitHub Docs — Copilot CLI configuration directory: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference>
- GitHub Docs — Copilot CLI command reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>

Relevant public contract:

- Authentication methods are OAuth device flow, environment variables, and GitHub CLI fallback.
- Environment-token precedence is `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`, before stored OAuth and `gh auth token` fallback.
- Stored OAuth defaults to OS keychain service `copilot-cli`:
  - macOS Keychain Access
  - Windows Credential Manager
  - Linux libsecret / Secret Service
- If the system keychain is unavailable, Copilot CLI may store a token in plaintext `~/.copilot/config.json`.
- Copilot CLI supports multiple accounts; users can list accounts with `/user list`, switch with `/user switch`, and add accounts with `copilot login` or `/login`.
- `~/.copilot/config.json` is automatically managed application state. Public docs call out fields such as `loggedInUsers`, `installedPlugins`, `firstLaunchAt`, and `staff` that remain in `config.json`.
- Other `~/.copilot` files include user settings, MCP/LSP config, agents, skills, hooks, permission decisions, and session history.

### Amp

Sources checked:

- Amp Owner's Manual: <https://ampcode.com/manual>
- Amp SDK documentation: <https://ampcode.com/manual/sdk>

Relevant public contract:

- Amp CLI is installed/run as `amp`; the SDK documentation says non-interactive use can set `AMP_API_KEY` from the user's Amp settings page, and local CLI users can run `amp login`.
- Amp reads user settings from `~/.config/amp/settings.json{,c}` on macOS/Linux, `%USERPROFILE%\.config\amp\settings.json{,c}` on Windows, or a custom `--settings-file`.
- Workspace settings are nearest `.amp/settings.json{,c}` and override user settings.
- MCP server configuration can include command/args/env or remote headers; workspace MCP servers require explicit approval, while global settings and `--mcp-config` do not require the same approval.
- Remote MCP OAuth tokens are stored under `~/.amp/oauth/` and refreshed automatically.

## Product conclusions

### Copilot CLI: do not add a simple builtin yet

A naïve builtin such as one source for `service=copilot-cli` plus `~/.copilot/config.json` is unsafe.

Required design before support:

1. **Profile add/import must ask which Copilot account to bind.** Public docs expose multi-account behavior, but a `mat` profile needs a stable target identity. Capturing the last-used account implicitly would make wrong-account swaps likely.
2. **OS keychain source scope must be account-aware.** `KeychainSource.account` and `OsKeyringSource.account` already exist, but Copilot's public docs only document service `copilot-cli`, not a stable keychain account/Secret Service attribute schema. Support requires non-secret platform tests or upstream documentation for account matching.
3. **Windows needs a new source backend.** `SourceType` currently covers `file`, macOS `keychain`, and Linux `os-keyring`. Copilot's default Windows store is Windows Credential Manager, so cross-platform Copilot support needs a `win-credential`-style source before Windows can be claimed.
4. **`~/.copilot/config.json` must be treated as application state, not just settings.** `loggedInUsers` and last-used account state must be captured/restored consistently with the credential entry. User-editable settings, hooks, skills, MCP config, permissions, and session history should not be blindly swapped as credentials.
5. **Ambient token fallbacks must be controlled.** `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, and `gh auth token` can override or bypass the stored profile. Any `mat exec` / `session run` support must either inject an explicit token profile and scrub competing env/fallbacks, or fail closed when ambient tokens are present.

### Amp: env-secret/session-run design, not profile-swap

Amp should not be represented by a normal builtin profile definition today.

Required design before support:

1. **Add an env-secret source concept first.** `AMP_API_KEY` is the documented non-interactive credential path. The current source model has no secret environment variable source and should not persist env secrets as arbitrary file credentials without an explicit threat model.
2. **Prefer command-scoped execution.** Amp support is more likely to be `mat exec` / `mat session run amp <profile> -- ...` that injects `AMP_API_KEY` into one child process, rather than OS-global profile swap.
3. **Block or scope workspace/user overrides.** Amp workspace `.amp/settings.json{,c}` overrides user settings; user settings and `--mcp-config` can define MCP env/headers. Product support needs a hard-stop list for credential-bearing config, MCP headers/env substitutions, and project-local overrides before claiming account isolation.
4. **Do not treat MCP OAuth as the primary Amp login.** `~/.amp/oauth/` is documented for remote MCP server OAuth tokens. Swapping it as an Amp account credential would mix tool-server auth with Amp account auth.
5. **Do not use broad HOME/XDG redirects as proof.** A broad directory redirect could catch unrelated tools and still miss env/API-key auth. Amp needs a CLI-specific credential/profile contract or command-scoped env injection.

## Stop conditions

Keep both CLIs blocked unless a new RALPLAN verifies all applicable items below.

### Copilot unblock checklist

- Stable account identifier for each profile, collected in CLI and TUI add/import flows.
- Platform-specific credential store contract:
  - macOS Keychain service+account or safe discovery rule.
  - Linux Secret Service attributes or safe `secret-tool` contract.
  - Windows Credential Manager target/account schema plus a new tested source backend.
- Minimal `~/.copilot/config.json` recapture/restore strategy that preserves account selection state without swapping unrelated settings, hooks, permissions, or session history.
- Ambient token policy for `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, GitHub CLI fallback, and BYOK provider env.
- Non-secret tests for missing entries, multi-account wrong-entry protection, login/logout/rotation, and fallback precedence.

### Amp unblock checklist

- ✅ Env-secret command-scoped injection contract documented in `docs/superpowers/specs/2026-06-15-env-secret-command-scoped-injection.md`; runtime/schema/storage implementation remains pending.
- ✅ Env-secret storage threat model/UX gate documented in `docs/superpowers/specs/2026-06-15-env-secret-storage-threat-model-ux.md`; runtime/schema/storage implementation remains pending.
- `AMP_API_KEY` injection path that fails closed when conflicting ambient Amp/provider credentials are present.
- Command-scoped `session run amp` design with a hard-stop policy for `.amp/settings.json{,c}`, `~/.config/amp/settings.json{,c}`, `--settings-file`, `--mcp-config`, MCP headers/env, and workspace overrides.
- Decision on whether `amp login` local state can be supported; if yes, upstream-documented storage/redirect/recapture contract is required.
- Tests proving no profile secret values are printed, logged, or copied into project/workspace config.

## Proposed follow-up PR order

1. **Copilot account-state RALPLAN** — choose the profile identity flow and exact `~/.copilot/config.json` fields to capture.
2. **Windows Credential Manager source R&D** — add a source type only after a non-secret read/write/delete contract and CI strategy are agreed.
3. **Copilot prototype** — macOS/Linux first if service/account attributes are proven; Windows only after source backend lands.
4. ✅ **Env-secret command-scoped injection design** — generic source/injection contract documented; runtime/schema/storage implementation remains pending (`docs/superpowers/specs/2026-06-15-env-secret-command-scoped-injection.md`).
5. ✅ **Env-secret storage threat model/UX gate** — backend policy ranking, consent UX, export/backup defaults, and fail-closed platform matrix documented; runtime/schema/storage implementation remains pending (`docs/superpowers/specs/2026-06-15-env-secret-storage-threat-model-ux.md`).
6. **Amp prototype** — only after env-secret runtime and Amp config hard-stop matrix; `mat exec` / `mat session run amp` only, with ambient env and config hard-stops.

## Product state

- Do not add `copilot` or `amp` to `BUILTIN_CLI_DEFS` yet; the env-secret design contract is not product support.
- User plugin definitions can statically describe files/keychains, but a passing `mat plugin validate` report must not be treated as Copilot/Amp security support.
- `mat session start` should remain unsupported for both until a credential redirect contract exists that is narrower than broad `HOME`/XDG redirection.
