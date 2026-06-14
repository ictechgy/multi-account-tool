# multi-account-tool (`mat`)

[한국어](README.ko.md) | English

📖 **Documentation:** [ictechgy.github.io/multi-account-tool](https://ictechgy.github.io/multi-account-tool/)

Switch between multiple AI CLI accounts (Claude Code, Codex, Gemini CLI, Aider, Kimi, Qwen, Crush, OpenCode, Goose) from a single TUI. No more `logout` / `login` shuffles — keep one profile per account and swap in a keystroke. Safe by default: macOS Keychain backups with automatic rollback, atomic file writes, plaintext-credential exclusion paths, OAuth refresh-token rotation awareness with TUI dialog (recapture / discard / cancel).

```
╭ Multi-Account Tool ────────────────────────────────╮
│  AI CLI account switcher                           │
╰─────────────────────────────────────────────────────╯

  > Claude Code            [active: personal] ✓
    Codex CLI              [active: work]     ✓
    Gemini CLI              [active: personal] ✓
```

---

## Why

- You use Claude Code, Codex, Gemini, and friends, each with multiple accounts (personal / work / team)
- You're tired of running `logout` → `login` every time you change context
- You forget which account is currently active

## How it works

`mat` swaps **only the credentials**. Everything else — hooks, agents, `CLAUDE.md`, conversation history, settings — stays untouched.

| CLI | Credential location | Swap strategy |
| --- | --- | --- |
| Claude Code | macOS Keychain (`Claude Code-credentials`) | Keychain entry swap |
| Codex CLI | `~/.codex/auth.json` | File swap |
| Gemini CLI | `~/.gemini/oauth_creds.json`, `google_accounts.json` | File swap |
| Aider | `~/.aider.conf.yml` | File swap |
| Kimi CLI | `~/.kimi/config.toml` | File swap |
| Qwen Code CLI | `~/.qwen/settings.json`, `~/.qwen/.env` | File swap |
| Crush | `~/.config/crush/crush.json`, `~/.local/share/crush/crush.json` | File swap |
| OpenCode | `~/.local/share/opencode/auth.json` (OS-agnostic, XDG standard) | File swap |
| Goose | macOS Keychain / Linux Secret Service (service `goose`, account `secrets`) + `~/.config/goose/secrets.yaml` + `config.yaml` | Multi-source (account-scoped Keychain/os-keyring; Linux swaps via `secret-tool` — see below) |

### OAuth Rotation Safety Matrix

Some CLIs use **OAuth refresh-token rotation** (RFC 6749 best practice): a refresh token may only be used once, after which the provider invalidates it. If `mat` restores an older snapshot of such a token, the provider rejects it as "already used" and the user is forced to re-login. The table below summarises which `mat`-supported CLIs are affected.

| CLI | Auth type | Rotation risk | `mat` safe modes |
| --- | --- | --- | --- |
| Codex CLI | OAuth (`tokens.refresh_token`, `tokens.account_id`) | 🔴 High — confirmed token revocation after stale restore | `mat freshness codex` before swap; `mat exec` for one-shot sessions |
| Gemini CLI | OAuth (`refresh_token` + `google_accounts.json.active`) | 🔴 High | Same as Codex |
| OpenCode | OAuth per provider (`provider.refresh`, `provider.accountId`) | 🔴 High | Same as Codex |
| Claude Code | macOS Keychain (Anthropic OAuth) | 🟢 Mitigated — identity-aware adapter (`subscriptionType` + macOS keychain account) | `mat exec`, and `mat freshness claude` (PR-H adapter, high-confidence rotation classification) |
| Goose | macOS Keychain + `secrets.yaml` / `config.yaml` (provider-routed) | 🟢 Mitigated — identity-aware adapter (provider key matrix + keychain account) | `mat freshness goose` reports per-source result, identity-aware |
| Aider / Kimi / Qwen / Crush | Static API key | 🟢 None | Standard swap suffices — but environment variables or project-local config can bypass `mat` (see "Platform support" below) |

Use `mat freshness [<cli>] [--profile <name>] [--json]` to inspect the live credentials versus the active profile before you swap. Exit code 0 means safe, exit code 1 means `mat` detected `stale` (identity changed or profile missing). For long-running sessions prefer `mat exec`, which automatically restores the previous profile after the command finishes — note that a `SIGKILL` to `mat` itself bypasses restore (see Security section).

> **OAuth rotation handling (PR-G/PR-I\*/PR-H all landed):** the TUI swap path detects freshness drift before swapping and shows an interactive **Recapture / Discard / Cancel** dialog (PR-G). Recapture saves the live credentials into the active profile via `snapshotLiveToProfile` then swaps; Discard skips the auto-snapshot (data loss); Cancel aborts. `mat exec` re-captures the live credentials on exit (PR-I\*) so rotation triggered during the command is preserved in the swap-target profile before restore — protected against `SIGINT`/`SIGTERM`/`SIGHUP` (`SIGKILL` is OS-level untrappable and falls back to stale-recovery on the next `mat` call). Claude/Goose identity-aware adapters (PR-H) classify rotation vs identity change with `high`/`medium` confidence — no more `[low conf]` dialog noise on safe swaps.

### Platform support

| CLI | macOS | Linux | Windows | Override / known limits |
| --- | --- | --- | --- | --- |
| Claude Code | ✅ | ✅ | ❌ | macOS Keychain on macOS; `~/.claude/.credentials.json` on Linux. `mat session` supports Linux via `CLAUDE_CONFIG_DIR`; macOS Keychain cannot be session-isolated |
| Codex CLI | ✅ | ✅ | ⚠️ untested | `~/.codex/auth.json` (cross-platform file path) |
| Gemini CLI | ✅ | ✅ | ⚠️ untested | `~/.gemini/oauth_creds.json` + `google_accounts.json`; `mat session` uses `GEMINI_CLI_HOME` with `.gemini` envSubdir |
| Google Antigravity (`agy`) | ❌ blocked | ❌ blocked | ❌ blocked | Not a Gemini CLI credential source. Official docs describe OS-native keyring auth; settings/cache live under `~/.gemini/antigravity-cli/`, but safe probes found no CLI-specific credential/data redirect (`GEMINI_CLI_HOME`, XDG envs, and `ANTIGRAVITY_EXECUTABLE_DATA_DIR` did not relocate app-data). A 0600 `antigravity-oauth-token` file may exist, but without a stable documented token-store/keyring contract mat does not swap or session-isolate it |
| Aider | ✅ | ✅ | ⚠️ untested | `mat session start` remains unsupported (no credential-dir env). `mat session run aider` is partial support: mat forces `--config <session>/command/aider.yml` + `--env-file <session>/command/.env` and hard-stops known argv/env/dotenv/OAuth-key/model-sidecar/provider-chain bypasses |
| Kimi CLI | ✅ | ✅ | ⚠️ untested | **env override**: `MOONSHOT_API_KEY` and friends bypass `~/.kimi/config.toml` |
| Qwen Code CLI | ✅ | ✅ | ⚠️ untested | Credential precedence: **shell env > `~/.qwen/.env` > `~/.qwen/settings.json`**. `mat` swaps both files but cannot affect shell env |
| Crush | ✅ | ✅ | ⚠️ untested | **project-local override**: `./.crush.json` / `./crush.json` in CWD takes precedence over `~/.config/crush/*`; `CRUSH_GLOBAL_*` env vars also override |
| OpenCode | ✅ | ✅ | ⚠️ untested | OS-agnostic XDG path (`$XDG_DATA_HOME/opencode/auth.json`, default `~/.local/share/opencode/auth.json`). `mat session start` is **EXPERIMENTAL** via broad `XDG_DATA_HOME`; `mat session run opencode` is command-scoped and hard-stops known local env/config bypasses |
| Goose | ✅ | ✅ os-keyring | ❌ | macOS Keychain / Linux Secret Service (`goose`/`secrets` via `secret-tool`) + `~/.config/goose/*.yaml`. On Linux mat includes the os-keyring source by default and requires `secret-tool` (libsecret-tools) + a keyring daemon — a missing tool or down daemon **errors out** rather than silently swapping stale YAML (Goose reaches the keyring via the libsecret *library*, so a missing `secret-tool` CLI does not prove the keyring is unused). Set `GOOSE_DISABLE_KEYRING=1` if you use the file backend; mat then omits os-keyring and swaps `secrets.yaml`. Windows Credential Manager not yet supported |

"⚠️ untested" = swap logic is platform-agnostic file I/O, but the project's CI runs macOS + Ubuntu only. Windows paths are inferred from each CLI's documentation, not exercised. Patches and bug reports welcome.

For a CLI-specific explanation of these support boundaries, run `mat support <cli>` (or `mat explain <cli>`). It prints the current swap/freshness/session status, caveats, ambient override risks, and last-verified upstream assumptions.

### Switch flow (lossless)

0. **Pre-swap freshness check** — if the live credentials drifted from the active profile (OAuth refresh-token rotation), `mat` shows a **Recapture / Discard / Cancel** dialog before steps 1–3 below. See "OAuth Rotation Safety Matrix" above for per-CLI classification.
1. The current live credentials are snapshotted into the currently active profile (automatic backup).
2. The target profile's stored credentials are atomically restored to the live location.
3. The active-profile pointer is updated.

Multi-source CLIs (e.g., Gemini with two files) get **partial-failure rollback**: if one source fails to restore, already-restored sources are reverted to the live backup to prevent split-state.

---

## Install

### Homebrew (recommended on macOS)

```bash
brew tap ictechgy/mat
brew install mat
```

### npm

```bash
npm install -g multi-account-tool
```

### From source

```bash
git clone https://github.com/ictechgy/multi-account-tool.git
cd multi-account-tool
npm install
npm run build
npm link
```

### Verify the install

```bash
mat --version                  # prints the installed semver
mat --help                     # subcommand list (TUI flags + `mat exec` / `mat session` / `mat freshness` / `mat doctor`)
node scripts/smoke-test.mjs    # source-checkout only — read-only smoke test (CLI defs load + paths resolve, never touches credentials)
```

The smoke test is read-only and safe to run on a machine with active mat profiles.

---

## Usage

```bash
mat              # launch the TUI
mat --version    # print installed version
mat --help       # short usage summary (subcommands: exec, session, freshness, doctor)
```

The TUI opens with **CLI → profile → switch**.

### First run

If the CLI's live credentials are already present, `mat` offers to import them as a `default` profile. The prompt is shown once and never auto-pops again (you can always capture manually later).

### Adding a new account

1. `mat` → pick a CLI → press `a` → enter a profile name (e.g., `work`)
2. Press `Enter` on the new profile to make it active. If the live credentials drifted from the **active profile**'s stored snapshot (OAuth refresh-token rotation), `mat` shows a **Recapture / Discard / Cancel** dialog before swapping — see Switch flow + OAuth Rotation Safety Matrix above.
3. In a separate terminal, log in to the CLI itself (`claude`, `codex`, `gemini`, …). This overwrites the live credentials with the new account.
4. Back in `mat`, press `c` on the same profile to **capture** the new live credentials into it
5. From now on, switch freely between profiles with `Enter`

### Key bindings

| Screen | Key | Action |
| --- | --- | --- |
| Anywhere | `q` / `Ctrl+C` | Quit |
| Anywhere | `Esc` | Back |
| Home / Profiles | `↑ ↓` | Move |
| Home / Profiles | `Enter` | Select / Switch |
| Profiles | `a` | Add profile |
| Profiles | `c` | Capture live credentials into the focused profile |
| Profiles | `r` | Rename |
| Profiles | `d` | Delete |
| Freshness dialog | `r` / `Enter` | Recapture (save live into active profile before swap) |
| Freshness dialog | `d` | Discard (skip auto-snapshot — data loss) |
| Freshness dialog | `c` / `Esc` | Cancel swap |

### `mat exec` — one-shot swap around a command

```bash
mat exec <cli> <profile> -- <cmd...>
```

Temporarily swap to `<profile>`, run `<cmd>`, then restore the previously active profile when the command exits.

```bash
# Run a single Claude session as the "work" profile, then restore "personal"
mat exec claude work -- claude

# Pair with lterm (optional — install with `npm install -g @ictechgy/lterm` first)
lterm send-keys "mat exec claude work -- claude" Enter
```

Behaviour:

- Requires an active profile for `<cli>` already set (use the TUI to capture live credentials first).
- A per-CLI lockfile (`~/.multi-account-tool/locks/<cli>.lock`) prevents two `mat exec` runs from racing on the same CLI. Stale locks from crashed processes are auto-recovered.
- Signals (`SIGINT` / `SIGTERM` / `SIGHUP`) are forwarded to the child; the child's exit code and signal are propagated back.
- **On exit, `mat` re-captures the live credentials into `<profile>` first** (so rotation triggered by `<cmd>` is preserved), then restores the previous active profile. The recapture has a default 10s timeout (`MAT_EXEC_RECAPTURE_TIMEOUT_MS` env override) to bound keychain-prompt hangs.
- The restore step runs in a `finally` block so normal exit, errors, and forwarded signals all trigger it. **A `SIGKILL` (or other untrappable signal: `SIGSEGV` / `SIGBUS`) to `mat` itself bypasses restore** — on the next `mat` invocation, the stale lock is auto-recovered and `mat` writes a stderr warning indicating the live credentials may still belong to `<profile>` rather than the previous active profile (policy B: warn + drop).

This is **temporal isolation**, not session isolation: while the child runs, the OS-global credentials are the `<profile>` ones. Two terminals running different `mat exec` commands serialise via the lock. Use `mat session` when you need true per-terminal isolation with different accounts running concurrently.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | Child exited 0 (and restore succeeded) |
| `2` | Usage error (`UsageError` — pre-spawn validation) |
| `74` | `mat`-side restore failed (`restoreError` set) — child result preserved on stdout/stderr |
| `75` | Another `mat exec` holds the per-CLI lock (`LockHeldError` — pre-spawn) |
| `128+N` | Child terminated by signal `N` (e.g., `130` for `SIGINT`) |
| `1` | Either: child exited non-zero with code `1`, OR `mat` itself hit an unexpected error before/after child execution |
| _other (e.g., `3`, `42`)_ | Child's own non-zero exit code is propagated as-is |

Note: `2` / `74` / `75` are reserved by `mat`'s own error model (pre-spawn validation, lock contention, post-spawn restore failure). Any other non-zero code below `128` is the child's own exit code propagated transparently. Use `restoreError` log lines on stderr to distinguish `74` from a child exit `74` (unlikely but possible).

### `mat session` — per-session isolation (different account per terminal, concurrently)

```bash
mat session start <cli> <profile>   # launch an isolated subshell on <profile>
mat session run <cli> <profile> -- [cli-args...]
                                  # run the builtin CLI executable directly in isolation
mat session list                    # running / orphan sessions
mat session stop <id>               # terminate a session or reap an orphan
```

Unlike `mat exec` (temporal isolation, serialized by a lock), `mat session` gives **true concurrent isolation** — two terminals can use *different* accounts of the same CLI at the same time:

```bash
# terminal A
mat session start codex work        # CODEX_HOME points at an isolated dir → "work" account

# terminal B (simultaneously)
mat session start codex personal    # independent isolated dir → "personal" account
```

**Mechanism — env injection + copy-isolation.** `mat session start` launches your `$SHELL` with the CLI's config-directory env var (for example, `CODEX_HOME`) pointing at a fresh per-session directory under `~/.multi-account-tool/sessions/<id>/`. mat **copies** the selected profile's credentials there with `0600` permissions, so CLI processes inside the subshell read only the isolated account. It also copies a small allow-list of non-credential data as session-only snapshots: for Codex, `config.toml` and `skills/` are copied into the isolated `CODEX_HOME`, so custom skills work without sharing the live `~/.codex` tree. On exit, mat **re-captures** only changed credentials back into the profile (for example, after OAuth rotation) and removes the session directory. mat never touches OS-global credentials or `mat exec`'s lock, so sessions can run concurrently without interfering with each other.

`mat session run` uses the same materialize → env injection → re-capture → cleanup lifecycle, but it does **not** open a shell. Instead, mat chooses the built-in CLI executable for `<cli>` (for example, `codex`) and passes `[cli-args...]` to that executable. The `--` tail is argv for the selected builtin CLI, not an arbitrary command. This framework is enabled only for built-ins with a safe command-scoped boundary today (Codex, Qwen, Kimi, Crush, Gemini CLI, Claude on Linux, OpenCode safer-run, and Aider partial-run).

**Supported CLIs** (those that relocate their *credential* directory via an env var):

| CLI | env var |
| --- | --- |
| Codex | `CODEX_HOME` |
| Qwen Code | `QWEN_HOME` |
| Kimi | `KIMI_SHARE_DIR` |
| Crush | `CRUSH_GLOBAL_CONFIG` + `CRUSH_GLOBAL_DATA` |
| Gemini CLI | `GEMINI_CLI_HOME` (`.gemini` envSubdir) |
| Claude Code (Linux only) | `CLAUDE_CONFIG_DIR` |
| OpenCode (**EXPERIMENTAL**) | `XDG_DATA_HOME` (`opencode` envSubdir; broad XDG side effects) |

**Not supported by `mat session start`** (no safe credential-relocating env var; `session start` errors out): `claude` on macOS (Keychain service name is not env-overridable), `aider` (credential channels include provider env vars / CLI args / project-local config, not a session-relocatable home file; use the narrower `mat session run aider` partial support instead), `goose` (keychain/OS-keyring credentials cannot be env-redirected), Google Antigravity / `agy` (native keyring plus no stable CLI-specific credential redirect; `HOME` redirect is too broad), and any user **plugin** CLI (built-in only trust boundary).

Exit codes mirror `mat exec`: `0` success, `2` usage error, `74` re-capture failed, `128+N` child signal `N` (self-raised), child's own non-zero code propagated otherwise.

**Limitations (read before relying on it):**

- **Credentials are isolated; copied config is session-local.** mat copies credentials into the session and re-captures only credentials on exit. A narrow allow-list may copy read-mostly non-secret data, but those copies are still isolated snapshots and are never written back. Today, Codex receives snapshots of `config.toml` and `skills/`, so skills are available in the session while any config or skill edits made there are discarded. Symlinks, hardlinks, special files, overly deep trees, oversized trees, and trees with too many entries fail before the shell is spawned. Everything else (history, caches, sessions, most config) is created inside the session and **discarded on exit**. Prefer `mat exec` for long single-account work where you want the real config/history, and `mat session` for concurrent multi-account isolation.
- **Ambient credential env is scrubbed for session children.** To keep profile copy-isolation from being bypassed, `mat session start` and `mat session run` do not inherit high-confidence provider/API endpoint env vars or AWS/GCP credential-chain env vars from the parent shell; AWS/GCP shared-credential fallbacks are hardened to inert values where possible. Broad non-provider tokens such as `GITHUB_TOKEN` are not scrubbed. If you intentionally need a provider env var with `mat session start`, export it inside the interactive session after it starts. For command-scoped `mat session run`, there is no post-start shell; any required env must be set in the invoked CLI's supported context, and Aider/OpenCode safer-run may hard-stop known provider env/config bypasses instead of forwarding them.
- **Aider `session run` is partial support; `session start aider` remains unsupported.** mat materializes the profile's `aider.yml` under the session command directory, then runs only the builtin `aider` executable with forced `--config <session>/command/aider.yml` and forced empty `--env-file <session>/command/.env`. It also scrubs AWS/Google ambient credential-chain fallbacks for the child (`AWS_SHARED_CREDENTIALS_FILE=/dev/null`, `AWS_CONFIG_FILE=/dev/null`, `AWS_EC2_METADATA_DISABLED=true`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null`, etc.). It hard-stops user `--config`/`-c`, `--env`/`--env-file`, `--api-key`, provider key/endpoint args (`--openai-api-key`, `--anthropic-api-key`, `--openai-api-base`, `--openai-base-url`, etc.), `--set-env`, model sidecar args (`--model-settings-file`, `--model-metadata-file`), any ambient `AIDER_*` env, provider credential/endpoint env such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_BASE`, AWS/Google/Vertex credential-chain env (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEXAI_PROJECT`, etc.), generic `*_API_KEY`/`*_TOKEN`/`*_SECRET_KEY` names, credential-bearing home/project `.env` candidates, non-empty/symlinked `~/.aider/oauth-keys.env`, non-empty/symlinked Aider model sidecars (`.aider.model.settings.yml`, `.aider.model.metadata.json`), profile-internal model-sidecar pointers, profile `set-env`, and Bedrock/Vertex model selectors/listing requests or aliases that rely on host AWS/Google credential chains. This is a command-scoped credential boundary, not a full Aider home/config isolation claim.
- **OpenCode `session start` remains EXPERIMENTAL; prefer `session run`.** OpenCode isolation uses `XDG_DATA_HOME` because upstream does not expose `OPENCODE_DATA_DIR`. In `session start`, this env affects the whole subshell: other XDG-aware tools (for example Crush) may write data or credentials into the ephemeral session directory and lose them when the session exits. `mat session run opencode ...` is narrower: it runs only the builtin `opencode` executable, scrubs AWS/Google ambient credential fallbacks for the child, disables OpenCode `.claude` prompt/skills loading, and hard-stops if known local config/env/plugin/tool/MCP/command/argv bypasses are present (`attach`, `pr`, `--dangerously-skip-permissions`, `--share`, `--command`, `--file`/`-f`, cwd/project-directory args such as `--dir`/`--cwd`/path-like dirs/symlinks, `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG*`, `OPENCODE_DB`, `OPENCODE_MODELS_*`, `OPENCODE_TEST_HOME`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`, `OPENCODE_TUI_CONFIG`, `OPENCODE_PERMISSION`, provider credential env vars or project `.env` assignments such as `*_API_KEY`, AWS keys, `GOOGLE_APPLICATION_CREDENTIALS`, `SNOWFLAKE_CORTEX_PAT`, or `.claude` prompt/skills fallback via `OPENCODE_DISABLE_CLAUDE_CODE*`, legacy `config`, `config.json`/`opencode.json{,c}`/`tui.json{,c}` global/managed/project/home `.opencode` config with `{file:...}` substitutions, `apiKey`, credential headers/options, provider env references, provider endpoint overrides, provider `npm`, AWS profile settings, `instructions`, `skills`, `reference(s)`, `share`, deprecated `mode`, agent `prompt`/`permission`/`tools`, `plugin`, `mcp`, `shell`, `formatter`/`lsp` command settings, local plugin/tool/command/mode/agent/skill directories, OpenCode `package.json` manifests, symlinked/unreadable config candidates, or macOS managed preference candidates).
- **`SIGKILL` orphans** the session directory (trap-impossible, same as `mat exec`); the next `mat session` call reaps it (owning process gone — PID-reuse-aware via the process start-time signature — **and** both the session's start time and its directory mtime older than 1h).
- **Parent-trust assumption:** isolation assumes `~/.multi-account-tool` and its parent are trusted; a symlinked `~/.multi-account-tool` is out of scope.
- **Same profile, two concurrent sessions:** re-capture uses a best-effort per-profile advisory lock (`locks/recapture/<cli>/<profile>.lock`) to serialize backup → stage → commit when available. If lock acquisition fails or times out, mat degrades to lock-free two-phase commit rather than blocking session shutdown; single-credential CLIs become last-writer-wins, and multi-credential CLIs (Qwen/Crush) can temporarily mix files from different sessions of the **same account**. It never writes a wrong-account credential and self-heals on next use. Prefer a distinct profile per terminal for deterministic re-capture.
- **`mat session stop`** sends `SIGTERM` only when it can confirm the owning process's identity (PID + start-time signature). If that can't be verified (rare — e.g. `ps` unavailable), it leaves the session untouched and asks you to retry, rather than risk killing an unrelated process that reused the PID.

### `mat freshness` — pre-swap safety check

```bash
mat freshness [<cli>] [--profile <name>] [--json] [--check-only]
```

Compare live credentials with the active (or specified) profile snapshot and report drift before you swap. If `<cli>` is omitted, mat reports every built-in/plugin CLI that currently has an active profile. Useful in CI chains (`mat freshness && deploy.sh`) to block stale-restore incidents (e.g., OAuth `refresh_token` revocation after wrong-profile restore).

```bash
# Quick safety check before a long Claude session
mat freshness claude

# Inspect a specific profile (machine-readable JSON for CI)
mat freshness codex --profile work --json

# Statusline/dashboard mode: print the same report, but do not fail on unsafe states
mat freshness --check-only
```

Each source is classified into one of four states — `fresh` (byte-identical), `rotated` (token rotated but identity preserved; safe to swap), `stale` (identity changed — a different account; **swap will revoke**), `inflight` (multi-source CLI partially updated — retry shortly).

`--check-only` is read-only monitoring mode: it still prints `stale` / low-confidence `rotated` / `inflight` results, but exits `0` so prompts, statuslines, and dashboards can display the warning without breaking the shell. Usage errors and source-read failures are not masked.

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | All sources are `fresh` or high-confidence `rotated` — safe to swap |
| `1` | One or more sources are `stale`, low-confidence `rotated`, or `inflight` — **fix before swap** (unless `--check-only`) |
| `2` | Usage error |
| `74` | Internal check failed (e.g., source read error) |

### `mat doctor` — read-only safety diagnostics

```bash
mat doctor [--json]
```

Run a metadata-only safety audit for every known CLI. `doctor` reports active-profile state, profile directory presence, live source presence where it can be checked without reading secret values, session support flags, plugin warnings, and high-confidence ambient override channels such as provider API-key env vars or project-local config files.

`mat doctor` intentionally does **not** compare stored/live credential contents and does not query OS keyring entries that would print secret values. Use `mat freshness <cli>` when you explicitly want the deeper OAuth rotation comparison.

```bash
# Human-readable report
mat doctor

# CI/statusline-friendly JSON report
mat doctor --json
```

See the OAuth Rotation Safety Matrix at the top of this README for per-CLI classification confidence.

### `mat support` / `mat explain` — explain CLI support boundaries

```bash
mat support <cli> [--json]
mat explain <cli> [--json]
```

Show what `mat` supports for one CLI and why. The report covers profile swap, freshness/drift checks, `mat session start`, `mat session run`, source types (without live paths or credential values), ambient/project override risks, and the last-verified upstream assumptions behind the support claim.

`explain` is an alias for `support`. Known blocked CLIs such as `agy` are explainable even when they are not valid profile-swap targets; user plugin CLIs are reported as profile-swap only with fallback freshness and no trusted session boundary.

```bash
mat support codex
mat support aider --json
mat explain agy
```

---

## Data layout

```
~/.multi-account-tool/
├── config.json                   # active profile pointer + flags
├── app.log                       # best-effort TUI warnings / diagnostic trail
├── cli-defs/                     # optional user plugins — see "Adding a new CLI"
│   └── <id>.json
├── locks/
│   ├── <cli>.lock/               # per-CLI `mat exec` lock dirs (auto-recovered on stale)
│   └── recapture/
│       └── <cli>/<profile>.lock/ # `mat session` profile recapture advisory locks
├── sessions/
│   └── <session-id>/             # ephemeral `mat session` dirs + session.json while running/orphaned
└── profiles/
    ├── claude/                   # credentials.json (macOS Keychain backup, plaintext)
    │   ├── personal/
    │   │   ├── credentials.json
    │   │   └── meta.json
    │   └── work/...
    ├── codex/                    # auth.json
    ├── gemini/                   # oauth_creds.json + google_accounts.json
    ├── aider/                    # aider.yml
    ├── kimi/                     # config.toml
    ├── qwen/                     # qwen-settings.json + qwen.env (prefixed saveAs to disambiguate)
    ├── crush/                    # crush-config.json + crush-data.json (config + data layers)
    ├── opencode/                 # auth.json (OS-agnostic XDG)
    └── goose/                    # goose-keyring.json (macOS Keychain / Linux Secret Service) + goose-secrets.yaml + goose-config.yaml
```

Files are created with `0600`, directories with `0700`.

---

## Security

### Accepted trade-offs (by design)

- **Keychain ACL relaxation** — All Keychain-backed sources (Claude Code credentials, Goose `goose`/`secrets` entry) are normally protected by a Keychain ACL that limits access to specific binaries. To avoid breaking the upstream CLI after a swap, `mat` rewrites the entry with `security add-generic-password -A`, which allows any process running as the same user to read it. Any process under your UID (including a malicious `npm postinstall`) could then read it silently. An opt-in `-T <path>` whitelist mode is planned for a future release.

- **Plaintext credential backups** — OAuth tokens are stored as plaintext JSON under `~/.multi-account-tool/profiles/`. Files are `0600` and directories `0700`, but they can still be picked up by disk backups. **Exclude the data directory from Time Machine / iCloud / cloud-synced folders**:

  ```bash
  xattr -w com.apple.metadata:com_apple_backup_excludeItem true ~/.multi-account-tool
  ```

- **`argv` exposure** — `security add-generic-password -w <value>` passes the OAuth token as an argv parameter (a limitation of the `security` CLI itself). It is briefly visible to `ps -ef`, BSM audit, and EDR logs. **Not recommended on machines with audit / EDR enabled.**

### Built-in safeguards

- All external commands use `spawn(argv)` only — no shell, no injection surface
- `security` is invoked only via the absolute path `/usr/bin/security` (defends against PATH-shim attacks)
- All file writes go through a single atomic helper (`.tmp → rename`, `O_EXCL + O_NOFOLLOW`, `0600`)
- Config mutations are funneled through `mutateConfig` (in-process serialization)
- Profile names: `[a-zA-Z0-9가-힣_.-]{1,40}` + NFC normalization + explicit rejection of `.` / `..` / `/` / `\` / NUL
- Keychain swap: backup → exact-acct delete → add. If `add` fails, the backup is auto-restored; if the rollback also fails, both errors surface together.
- Restore is rollback-safe for multi-source CLIs (already-restored sources are reverted to the live backup on partial failure)
- Error messages are redacted (JWT pattern + 50+ char base64-like sequences → `[redacted]`), and session allow-list paths are sanitized for terminal control characters before they can reach stderr
- Dependencies: `npm audit` clean

### Not recommended on

- Shared workstations
- Multi-user hosts
- Managed / audit-enabled enterprise devices
- Home directories synced to a cloud folder

---

## Adding a new CLI

Two options.

### 1. User plugin — no code change required (recommended for personal use)

Drop a JSON file at `~/.multi-account-tool/cli-defs/<id>.json`. Example template for an arbitrary CLI:

```json
{
  "id": "my-cli",
  "name": "My CLI",
  "sources": [
    { "type": "file", "path": "~/.config/my-cli/credentials.json", "saveAs": "credentials.json" }
  ]
}
```

mat loads every `*.json` in that directory at startup. Invalid plugins are warned and skipped — mat keeps working. Built-in CLIs (`claude`, `codex`, `gemini`, `aider`, `kimi`, `qwen`, `crush`, `opencode`, `goose`) cannot be overridden — id collision is rejected.

Field rules:
- `id`: ASCII letter start, then letters/digits/`_`/`-`, 1~32 chars (must not collide with built-ins).
- `name`: any non-empty string (display label).
- `sources[].type`: `'file'` or `'keychain'` (keychain is macOS-only).
- `sources[].saveAs`: ASCII filename, 1~64 chars (`[a-zA-Z0-9._-]`).
- `sources[].path` (file): any non-empty string (your filesystem path, `~/` expanded).
- `sources[].service` (keychain): any non-empty string (Keychain service name).
- `sources[].account` (keychain, **optional**): scope `mat` to a specific `-s <service> -a <account>` entry. Required for **generic / multi-account services** (e.g., Goose's `goose`/`secrets` or any CLI with multiple Keychain entries under the same service) — without it, `mat` may match the wrong account. Validation: non-empty string, no NUL chars. Omit for single-account services (default behaviour preserved).

### 2. Built-in addition — requires mat repo PR

Add an entry to `src/core/cli-defs.ts`:

```ts
{
  id: 'foo',
  name: 'Foo CLI',
  sources: [
    { type: 'file', path: '~/.foo/credentials.json', saveAs: 'credentials.json' }
  ]
}
```

Use this for community-shared CLIs that should ship with mat. PRs welcome.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md) for release history and notable changes (Keep a Changelog format, Semantic Versioning).

## Roadmap

See [ROADMAP.md](./ROADMAP.md) for v0.4+ plans:

- ~~Plugin mechanism for community-contributed CLI definitions~~ ✅ (v0.3)
- ~~Aider built-in support~~ ✅ (v0.3) + ~~Kimi / Qwen / Crush / OpenCode~~ ✅ (v0.3.x)
- ~~Session-scoped credential isolation~~ ✅ (v0.4.x — `mat session start/list/stop`: env-injection + copy-isolate, concurrent multi-account; the `lterm` shim integration below is still pending)
- ~~`mat session run <cli> <profile> -- [cli-args...]` framework~~ ✅ — command-scoped safer-run foundation. ~~OpenCode hard-stop probes~~ ✅; ~~Aider forced config/env-file partial-run~~ ✅. Antigravity remains research-only until upstream documents a stable auth-store contract. See [the R&D note](./docs/superpowers/specs/2026-06-12-command-scoped-session-run-rd.md).
- More built-in CLIs — ~~Goose~~ ✅ (v0.4.0 account-scoped Keychain; Linux Secret Service added via the `os-keyring` source type). Copilot / Amp remain deferred — Copilot needs multi-account `/user switch` application-state swap, and Windows Credential Manager support is still pending (a separate follow-up). Cursor Agent: plugin recommended (keychain service name not publicly documented).
- **Goose Linux**: on Linux, mat swaps Goose's default `secret-service` backend (libsecret, GNOME Keyring/KWallet) through the `os-keyring` source (`secret-tool` CLI, `goose`/`secrets`) plus the `~/.config/goose/*.yaml` files. Behavior by configuration:
  - **Default (keyring)**: the os-keyring source is included and requires `secret-tool` (libsecret-tools) + a running keyring daemon. A missing tool or a down/denied daemon produces an **explicit error** — mat does *not* silently fall back to YAML, because Goose accesses the keyring through the libsecret *library* (a separate package from the `secret-tool` CLI), so a missing CLI does not prove the keyring is unused. Silently swapping `secrets.yaml` for an active keyring user would be a wrong-account write. An absent keyring entry (vs. a missing tool) is a normal "not found" and skips to the YAML files.
  - **File backend**: set `GOOSE_DISABLE_KEYRING`. mat treats the env var as present-means-disabled (**any value**, including `0`/`false`/empty) — matching Goose's own `env::var(...).is_ok()` check — and then **omits** the keyring source (os-keyring on Linux, Keychain on macOS), swapping only `secrets.yaml` + `config.yaml`. A `config.yaml`-only `keyring: false` setting is not auto-detected, so set the env var too.
- `lterm claude --profile <name>` shim wrapper

---

## License

MIT — [LICENSE](./LICENSE)
