# multi-account-tool (`mat`)

[한국어](README.ko.md) | English

📖 **Documentation:** [ictechgy.github.io/multi-account-tool](https://ictechgy.github.io/multi-account-tool/)

Use one TUI to switch between multiple AI CLI accounts (Claude Code, Codex, Gemini CLI, Aider, Kimi, Qwen, Crush, OpenCode, Goose, Grok Build). Store one profile per account and switch with a keystroke instead of cycling through `logout` → `login`.

By default, `mat` takes the conservative path: it backs up macOS Keychain entries, rolls back partial failures, writes files atomically, calls out plaintext-credential backup risks, and checks credential freshness (including OAuth refresh-token rotation) before a swap. When live credentials have drifted, the TUI asks whether to Recapture, Discard, or Cancel before it swaps.

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

- You use Claude Code, Codex, Gemini, or similar CLIs with multiple accounts (personal / work / team)
- You are tired of running `logout` → `login` every time you change context
- You want the currently active account to be explicit before you start work

## How it works

`mat` swaps **only credentials**. Everything else — hooks, agents, `CLAUDE.md`, conversation history, settings — stays untouched.

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
| Goose | Existing Keychain/Secret Service + YAML artifacts, five fixed provider files and two bounded provider cache directories directly under `~/.config/goose/` | Profile swap only; fixed v1.43 paths, no discovery or session isolation. **Profiles captured before 0.8.1 hold no provider artifacts — re-capture each one while its own account is logged in** |
| Grok Build | `~/.grok/auth.json` | File swap (profile-swap-only) |

### OAuth Rotation Safety Matrix

Some CLIs use **OAuth refresh-token rotation** (RFC 6749 best practice): a refresh token may be single-use, so the provider invalidates it after the next successful refresh. Restoring an older snapshot can then make the provider reject the token as "already used", forcing a re-login. The table below summarizes the risk for CLIs that `mat` supports.

| CLI | Auth type | Rotation risk | `mat` safe workflows |
| --- | --- | --- | --- |
| Codex CLI | OAuth (`tokens.refresh_token`, `tokens.account_id`) | 🔴 High — confirmed token revocation after stale restore | `mat freshness codex` before swap; `mat exec` for one-shot commands |
| Gemini CLI | OAuth (`refresh_token` + `google_accounts.json.active`) | 🔴 High | Same as Codex |
| OpenCode | OAuth per provider (`provider.refresh`, `provider.accountId`) | 🔴 High | Same as Codex |
| Claude Code | macOS Keychain (Anthropic OAuth) | 🟢 Mitigated — identity-aware adapter (`subscriptionType` + macOS keychain account) | `mat exec`, and `mat freshness claude` (high-confidence rotation classification) |
| Goose | Existing backend/YAML plus seven fixed v1.43 provider cache artifacts | ⚠️ Provider cache diffs are opaque low-confidence rotation; known YAML/keyring paths remain identity-aware | `mat freshness goose` reports every fixed source; opaque diffs require attention |
| Crush | Hyper/Copilot OAuth (`providers.*.oauth`) plus mirrored/static API keys | ⚠️ No stored account identity — adapter-backed conservative low-confidence byte-diff only (not confirmed rotation) | `mat freshness crush` before swap; project/`CRUSH_*`/XDG/provider-env overrides can bypass swapped globals (see Platform support) |
| Grok Build | Browser/OIDC `~/.grok/auth.json` | ⚠️ Unknown — fallback byte-diff only, no identity adapter yet | Use only the TUI profile switch (select `grok`, then the profile); review config/env/project overrides before relying on the selected profile |
| Aider / Kimi / Qwen | Static API key | 🟢 None | Standard swap suffices — but environment variables or project-local config can bypass `mat` (see "Platform support" below) |

Use `mat freshness [<cli>] [--profile <name>] [--json]` to inspect the live credentials versus the active profile before you swap. Exit code 0 means safe: every source is `fresh` or adapter-confirmed `rotated` with high/medium confidence. Exit code 1 means `mat` found an unsafe pre-swap state: `stale`, low-confidence `rotated` from fallback/byte-diff classification, `inflight`, or a missing profile/source. For long-running sessions prefer `mat exec`, which automatically restores the previous profile after the command finishes — note that a `SIGKILL` to `mat` itself bypasses restore (see Security section).

> **OAuth rotation handling:** the TUI swap path checks freshness before swapping and shows an interactive **Recapture / Discard / Cancel** dialog when it detects drift. Recapture saves the live credentials into the active profile via `snapshotLiveToProfile` before the swap; Discard skips the auto-snapshot (data loss); Cancel aborts. `mat exec` re-captures live credentials on exit so rotation triggered during the command is preserved in the swap-target profile before restore — protected against `SIGINT`/`SIGTERM`/`SIGHUP` (`SIGKILL` is OS-level untrappable and falls back to stale-recovery on the next `mat` call). Claude/Goose identity-aware adapters classify rotation vs identity change with `high`/`medium` confidence, removing `[low conf]` dialog noise on safe swaps.

### Platform support

| CLI | macOS | Linux | Windows | Overrides / known limits |
| --- | --- | --- | --- | --- |
| Claude Code | ✅ | ✅ | ❌ | macOS Keychain on macOS; `~/.claude/.credentials.json` on Linux. `mat session` supports Linux via `CLAUDE_CONFIG_DIR`; macOS Keychain cannot be session-isolated |
| Codex CLI | ✅ | ✅ | ⚠️ untested | `~/.codex/auth.json` (cross-platform file path) |
| Gemini CLI | ✅ | ✅ | ⚠️ untested | `~/.gemini/oauth_creds.json` + `google_accounts.json`; `mat session` uses `GEMINI_CLI_HOME` with `.gemini` envSubdir. Google moved personal/free-tier CLI access toward Antigravity on 2026-06-18; enterprise/Cloud/API-key paths remain separate, and this availability change does not alter `mat`'s credential boundary. |
| Google Antigravity (`agy`) | ❌ blocked | ❌ blocked | ❌ blocked | Rechecked at 1.1.2. It is not a Gemini CLI credential source. Public docs describe system-keyring auth with Google Sign-In fallback, but no stable keyring service/account, token profile, credential redirect, or recapture contract. Settings/cache under `~/.gemini/antigravity-cli/` and any observed `antigravity-oauth-token` file are not enough for safe support. See the [auth-store research note](./docs/superpowers/specs/2026-06-14-antigravity-auth-store-research.md). |
| Aider | ✅ | ✅ | ⚠️ untested | `mat session start` remains unsupported (no credential-dir env). `mat session run aider` is partial support: mat forces `--config <session>/command/aider.yml` + `--env-file <session>/command/.env` and hard-stops known argv/env/dotenv/OAuth-key/model-sidecar/provider-chain bypasses |
| Kimi CLI | ✅ | ✅ | ⚠️ untested | **env override**: `MOONSHOT_API_KEY` and friends bypass `~/.kimi/config.toml` |
| Qwen Code CLI | ✅ | ✅ | ⚠️ untested | Rechecked at v0.19.10. Profile swap and `mat session start qwen` redirect `QWEN_HOME`, but are advisory only: Qwen can still use shell/project/ancestor/home configuration and custom `modelProviders[].envKey` sources. `mat session run qwen` remains intentionally unsupported until the complete auth/source contract can be fail-closed. |
| Crush | ✅ | ✅ | ⚠️ untested | Hyper/Copilot login may persist OAuth plus mirrored `api_key` under `providers.*` (pin `charmbracelet/crush@7b24cc09…`, retrieved 2026-07-15 KST). No stable account identity is stored, so freshness diffs stay low-confidence attention-required. **project-local / env override**: `./.crush.json` / `./crush.json`, `CRUSH_GLOBAL_*`, XDG roots, and provider API-key env can bypass swapped globals |
| OpenCode | ✅ | ✅ | ⚠️ untested | Rechecked against canonical `anomalyco/opencode` v1.18.1. OS-agnostic XDG path (`$XDG_DATA_HOME/opencode/auth.json`, default `~/.local/share/opencode/auth.json`). `mat session start` is **EXPERIMENTAL** via broad `XDG_DATA_HOME`; `mat session run opencode` is command-scoped and hard-stops known local env/config bypasses |
| Goose | ✅ | ✅ os-keyring | ❌ | Existing `goose`/`secrets` backend + YAML behavior is unchanged. On Linux the default keyring path requires `secret-tool` (libsecret-tools) and a running keyring daemon; missing/denied tooling is an **explicit error**, not a stale-YAML fallback, because a missing CLI does not prove Goose's libsecret keyring is unused. Use `GOOSE_DISABLE_KEYRING=1` only for Goose's file backend (presence-only; any value disables keyring). MAT swaps exactly five reviewed files and two bounded directories **directly below `~/.config/goose/`** (`gemini_oauth/tokens.json`, `chatgpt_codex/tokens.json`, `kimicode/token.json`, `xai_oauth/tokens.json`, `huggingface/oauth/tokens.json`, plus the `githubcopilot/` and `databricks/oauth/` trees), verified against Goose v1.43.0 source commit `5a9eb7e`. **Releases before 0.8.1 looked one directory too deep (`~/.config/goose/providers/...`), a path that never existed upstream, so those profiles hold no provider artifacts.** Re-capture each Goose profile **while that profile's own account is the one currently logged in to Goose** — the provider cache always belongs to whoever is logged in right now. Do **not** re-capture immediately after a switch that reported a carried-over artifact: at that moment the live cache still belongs to the *previous* account, so capturing would store the wrong account's token in the profile you just switched to. A switch that finds a live provider cache with no counterpart in the profile reports it as carried over instead of silently skipping it, and tells you not to re-capture. `ANTHROPIC_HOST`, `HF_TOKEN`, `GOOSE_PATH_ROOT`, and `XDG_CONFIG_HOME` can bypass or relocate these artifacts and are reported as ambient warnings; a relocated Goose config directory is unsupported. Goose creates these cache directories without an explicit mode, so a group-writable umask yields `0775` and MAT fails closed on its private-parent check — run `mat doctor` to see which artifact is affected, then `chmod g-w,o-w` that directory. MAT never scans provider directories or enables session/run. Provider cache schemas remain opaque until redacted fixtures admit fields. Windows is unsupported. |
| Grok Build | ✅ | ✅ | ⚠️ untested | Current support swaps only the primary signed-in browser/OIDC token file `~/.grok/auth.json` as `grok-auth.json`. `mat session start/run grok` is unsupported. `~/.grok/config.toml` model `api_key`/`env_key`, `XAI_API_KEY`, `GROK_*` auth/model env, `GROK_HOME`, project `.grok/config.toml`, and MCP credentials can override or bypass `auth.json`; unset/review those before relying on a selected profile. |

"⚠️ untested" = swap logic is platform-agnostic file I/O, but the project's CI runs macOS + Ubuntu only. Windows paths are inferred from each CLI's documentation, not exercised. Patches and bug reports welcome.

For the exact support boundary of one CLI, run `mat support <cli>` (or `mat explain <cli>`). The report shows the current swap, freshness, and session support; caveats; ambient override risks; and the last upstream assumptions `mat` verified.

During foreground profile switching and `mat exec`, `mat` warns about high-confidence ambient bypass channels such as provider API-key env vars or project-local config files. The warning is informational: `mat` does **not** block or scrub those channels yet. If the override is intentional, continue; otherwise unset or remove the named env/config source before relying on the selected profile.

#### Why Grok session isolation is not enabled yet

Grok Build support is intentionally **profile-swap-only** for now. xAI's public Build docs ([Getting Started](https://docs.x.ai/build/overview), [Enterprise Deployments](https://docs.x.ai/build/enterprise)) describe multiple credential, config, and account-selection channels: browser OIDC/device auth, external auth-provider commands, direct API-key auth via `XAI_API_KEY`, model-level `api_key` / `env_key` in `~/.grok/config.toml`, managed/requirements config layers, project-visible instructions/plugins/hooks/MCP servers, and `grok inspect` for the combined discovery view. Because `~/.grok/auth.json` is only one credential channel, copying or redirecting that file alone would not prove that a `mat session` child is using **only** the selected profile.

A future `mat session run grok` needs a separate design that either (1) creates an API-key-only boundary and hard-stops browser/OIDC, config, env, project, plugin, hook, and MCP override channels, or (2) relies on an upstream-supported Grok credential/config-root redirect with clear recapture semantics. Until then, switch Grok profiles through the TUI (select `grok`, then the target profile) and unset/review the listed override sources before trusting the active profile.

### Switch flow (lossless)

0. **Pre-swap freshness check** — if the live credentials drifted from the active profile (OAuth refresh-token rotation), `mat` shows a **Recapture / Discard / Cancel** dialog before steps 1–3 below. See "OAuth Rotation Safety Matrix" above for per-CLI classification.
1. The current live credentials are snapshotted into the active profile (automatic backup).
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
mat --help                     # subcommand list (TUI flags + `mat exec` / `mat session` / `mat plugin` / `mat freshness` / `mat doctor`)
node scripts/smoke-test.mjs    # source-checkout only — read-only smoke test (CLI defs load + paths resolve, never touches credentials)
```

The smoke test is read-only and safe to run on a machine with active mat profiles.

---

## Usage

```bash
mat              # launch the TUI
mat --version    # print installed version
mat --help       # short usage summary (subcommands: exec, session, plugin, freshness, doctor)
```

The TUI opens with **CLI → profile → switch**.

### First run

If the CLI's live credentials are already present, `mat` offers to import them as a `default` profile. The prompt appears only once and is not shown automatically again; you can always capture manually later.

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

Behavior:

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
mat session run <cli> <profile> --check|--explain [--json] -- [cli-args...]
                                  # dry-run the exact session-run validators without spawning
mat session list [--json]           # running / orphan sessions
mat session stop <id>               # terminate a session or reap an orphan
mat status [--json]                 # active-profile + session summary for dashboards/statuslines
```

Unlike `mat exec` (temporal isolation, serialized by a lock), `mat session` gives **true concurrent isolation** — two terminals can use *different* accounts of the same CLI at the same time:

```bash
# terminal A
mat session start codex work        # CODEX_HOME points at an isolated dir → "work" account

# terminal B (simultaneously)
mat session start codex personal    # independent isolated dir → "personal" account
```

**Mechanism — env injection + copy-isolation.** `mat session start` launches your `$SHELL` with the CLI's config-directory env var (for example, `CODEX_HOME`) pointing at a fresh directory under `~/.multi-account-tool/sessions/<id>/`. `mat` copies the selected profile's credentials there with `0600` permissions, so CLI processes inside the subshell read only that isolated account.

A small allow-list of non-credential data may also be copied as session-local snapshots. For Codex, `config.toml` and `skills/` are copied into the isolated `CODEX_HOME`, so custom skills are available without sharing the live `~/.codex` tree. On exit, `mat` re-captures only changed credentials back into the profile (for example, after OAuth rotation), then removes the session directory. It never touches OS-global credentials or the `mat exec` lock, so sessions can run concurrently without interfering with each other.

`mat session run` uses the same materialize → env injection → re-capture → cleanup lifecycle without opening a shell. `mat` selects the built-in executable for `<cli>` (for example, `codex`) and passes `[cli-args...]` directly to it. The `--` tail is argv for that selected CLI, not an arbitrary shell command. Today this command-scoped boundary is enabled only for built-ins with a known safe run path: Codex, Kimi, Crush, Gemini CLI, Claude on Linux, OpenCode safer-run, and Aider partial-run. Qwen is intentionally excluded.

Before a real run, use `mat session run <cli> <profile> --check -- [cli-args...]` (or `--explain`) to exercise the **same** support, profile, executable, Aider, and OpenCode hard-stop validators without spawning the CLI or creating a session directory. Exit code `0` means the real run would pass preflight, `1` means a validation blocker was found, and `2` means usage/parser error. Add `--json` to that `--check`/`--explain` command for an automation-friendly report with blockers, phases, selected executable, profile existence, and exact argv.

For dashboards and statuslines, `mat status --json` emits a stable schema-v1 summary of active profiles and sessions. Active profiles may include capture-time identity metadata such as masked account/email fingerprints or allowlisted tier/provider-mode signals; status never parses credential files or keyring entries on demand. `mat session list --json` emits schema-v1 lifecycle entries (`active` / `orphan` / `unknown`) with owner/child status and root env names only; it never includes session root paths. Mutating session lifecycle commands append best-effort, redacted JSONL events to `~/.multi-account-tool/audit.jsonl`; persistent audit entries hash profile/session identifiers and redact secret-like strings.

#### Prompt/statusline snippets

Prompt renderers can consume `mat status --json`, but do not run it uncached on every redraw: the status report may inspect session liveness. The examples below cache for two seconds, fail empty if `mat` or JSON parsing fails, and are display-only. They call only `mat status --json`; they do not parse `~/.multi-account-tool`, credential files, keyrings, `mat freshness`, or `mat doctor`.

Put the shared helper in a file such as `~/.config/mat/statusline.zsh`:

```zsh
: ${MAT_STATUS_CACHE_TTL:=2}
: ${MAT_STATUS_CACHE:="${XDG_CACHE_HOME:-$HOME/.cache}/mat/status.json"}

mat_status_cached() {
  local now mtime cache_dir tmp
  cache_dir="$(dirname "$MAT_STATUS_CACHE")" || return 0
  mkdir -p "$cache_dir" 2>/dev/null || return 0

  now=$(date +%s)
  if [[ -r "$MAT_STATUS_CACHE" ]]; then
    mtime=$(stat -f %m "$MAT_STATUS_CACHE" 2>/dev/null)
    if [[ -z "$mtime" || "$mtime" == *[!0-9]* ]]; then
      mtime=$(stat -c %Y "$MAT_STATUS_CACHE" 2>/dev/null || echo 0)
    fi
    if [[ -n "$mtime" && "$mtime" != *[!0-9]* ]] && (( now - mtime < MAT_STATUS_CACHE_TTL )); then
      cat "$MAT_STATUS_CACHE"
      return 0
    fi
  fi

  tmp="${MAT_STATUS_CACHE}.$$.$RANDOM"
  if command mat status --json > "$tmp" 2>/dev/null && mv "$tmp" "$MAT_STATUS_CACHE" 2>/dev/null; then
    cat "$MAT_STATUS_CACHE"
  else
    rm -f "$tmp"
  fi
}

mat_statusline() {
  mat_status_cached | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const r=JSON.parse(s||"{}");const profiles=(r.activeProfiles||[]).map(p=>`${p.cliId}:${p.profileName}`).join(" ");const sessions=r.sessions||{};const warn=(sessions.orphan||sessions.unknown)?`⚠${sessions.orphan||0}/${sessions.unknown||0}`:"";const out=[profiles,warn].filter(Boolean).join(" ");if(out)process.stdout.write(out);}catch{}});' 2>/dev/null
}
```

Use it from zsh `RPROMPT`:

```zsh
source ~/.config/mat/statusline.zsh
setopt prompt_subst
RPROMPT='$(mat_statusline)'
```

Use it from tmux:

```tmux
set -g status-right '#(zsh -lc "source ~/.config/mat/statusline.zsh && mat_statusline")'
```

Use it from Starship:

```toml
[custom.mat]
command = 'zsh -lc "source ~/.config/mat/statusline.zsh && mat_statusline"'
when = 'command -v zsh >/dev/null 2>&1 && command -v mat >/dev/null 2>&1 && command -v node >/dev/null 2>&1'
format = '[$output]($style) '
style = 'cyan'
```

The default formatter prints compact output such as `codex:work gemini:personal ⚠1/0`, where the warning counts are `orphan/unknown` sessions. Adjust the Node formatter if you want a different shape.

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

**Not supported by `mat session start`** (no safe credential-relocating env var; `session start` errors out): `claude` on macOS (Keychain service name is not env-overridable), `aider` (credential channels include provider env vars / CLI args / project-local config, not a session-relocatable home file; use the narrower `mat session run aider` partial support instead), `goose` (keychain/OS-keyring credentials cannot be env-redirected), `grok` (profile-swap-only `~/.grok/auth.json`; config/env/project/MCP bypasses need a separate session-isolation design), Google Antigravity / `agy` (native keyring plus no stable CLI-specific credential redirect; `HOME` redirect is too broad), and any user **plugin** CLI (built-in only trust boundary).

Exit codes mirror `mat exec`: `0` success, `2` usage error, `74` re-capture failed, `128+N` child signal `N` (self-raised), child's own non-zero code propagated otherwise.

**Limitations (read before relying on it):**

- **Credentials are isolated; copied config is session-local.** mat copies credentials into the session and re-captures only credentials on exit. A narrow allow-list may copy read-mostly non-secret data, but those copies are still isolated snapshots and are never written back. Today, Codex receives snapshots of `config.toml` and `skills/`, so skills are available in the session while any config or skill edits made there are discarded. Symlinks, hardlinks, special files, overly deep trees, oversized trees, and trees with too many entries fail before the shell is spawned. Everything else (history, caches, sessions, most config) is created inside the session and **discarded on exit**. Prefer `mat exec` for long single-account work where you want the real config/history, and `mat session` for concurrent multi-account isolation.
- **Ambient credential env is scrubbed for session children.** To keep profile copy-isolation from being bypassed, `mat session start` and `mat session run` do not inherit high-confidence provider/API endpoint env vars or AWS/GCP credential-chain env vars from the parent shell; AWS/GCP shared-credential fallbacks are hardened to inert values where possible. Broad non-provider tokens such as `GITHUB_TOKEN` are not scrubbed. If you intentionally need a provider env var with `mat session start`, export it inside the interactive session after it starts. For command-scoped `mat session run`, there is no post-start shell; any required env must be set in the invoked CLI's supported context, and Aider/OpenCode safer-run may hard-stop known provider env/config bypasses instead of forwarding them.
- **Aider `session run` is partial support; `session start aider` remains unsupported.** mat materializes the profile's `aider.yml` under the session command directory, then runs only the builtin `aider` executable with forced `--config <session>/command/aider.yml` and forced empty `--env-file <session>/command/.env`. It also scrubs AWS/Google ambient credential-chain fallbacks for the child (`AWS_SHARED_CREDENTIALS_FILE=/dev/null`, `AWS_CONFIG_FILE=/dev/null`, `AWS_EC2_METADATA_DISABLED=true`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null`, etc.). It hard-stops user `--config`/`-c`, `--env`/`--env-file`, `--api-key`, provider key/endpoint args (`--openai-api-key`, `--anthropic-api-key`, `--openai-api-base`, `--openai-base-url`, etc.), `--set-env`, model sidecar args (`--model-settings-file`, `--model-metadata-file`), any ambient `AIDER_*` env, provider credential/endpoint env such as `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_BASE`, AWS/Google/Vertex credential-chain env (`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEXAI_PROJECT`, etc.), generic `*_API_KEY`/`*_TOKEN`/`*_SECRET_KEY` names, credential-bearing home/project `.env` candidates, non-empty/symlinked `~/.aider/oauth-keys.env`, non-empty/symlinked Aider model sidecars (`.aider.model.settings.yml`, `.aider.model.metadata.json`), profile-internal model-sidecar pointers, profile `set-env`, and Bedrock/Vertex model selectors/listing requests or aliases that rely on host AWS/Google credential chains. This is a command-scoped credential boundary, not a full Aider home/config isolation claim.
- **Qwen is profile-swap plus advisory session-start support; `session run qwen` is disabled.** `mat session start qwen` redirects `QWEN_HOME` to an isolated profile copy, but it does not claim to contain Qwen's shell environment, project/ancestor dotenv discovery, legacy/home configuration, settings-based auth routing, or interactive working-directory changes. Ambient detection runs for app-based switching, `mat exec`, and `mat doctor`, not for `session start`. Use a controlled profile swap (`mat exec qwen <profile> -- qwen ...`) when you need a noninteractive profile selection; do not treat it as a command-scoped credential boundary. `mat session run qwen` will remain unavailable until the pinned Qwen v0.19.10 all-auth-source contract can be parsed and rechecked fail-closed.
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

Each source is classified into one of four states — `fresh` (byte-identical), `rotated` (token rotated), `stale` (identity changed — a different account; **swap will revoke**), `inflight` (multi-source CLI partially updated — retry shortly). `rotated` is safe only when an adapter can preserve identity with high/medium confidence. Fallback byte-diff results and parser failures can only say "bytes changed"; those low-confidence `rotated` results are treated as unsafe for exit-code purposes and return `1` unless `--check-only` is used.

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

Run a metadata-only safety audit across every known CLI. `doctor` reports active-profile state, sanitized capture-time identity metadata when present, profile directory presence, live source presence when it can be checked without reading secret values, session support flags, plugin warnings, and high-confidence ambient override channels such as provider API-key env vars or project-local config files.

`mat doctor` intentionally does **not** compare stored/live credential contents, parse profile credential files to backfill identity, or query OS keyring entries that would print secret values. Use `mat freshness <cli>` when you explicitly want the deeper OAuth rotation comparison.

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

Show exactly what `mat` supports for one CLI and why. The report covers profile swap, freshness/drift checks, `mat session start`, `mat session run`, source types (without live paths or credential values), static capture-time profile identity signal support, ambient/project override risks, and the last verified upstream assumptions behind the support claim.

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
├── audit.jsonl                   # best-effort redacted session lifecycle audit log
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
    ├── goose/                    # goose-keyring.json (macOS Keychain / Linux Secret Service) + goose-secrets.yaml + goose-config.yaml
    └── grok/                     # grok-auth.json (profile-swap-only ~/.grok/auth.json)
```

Files are created with `0600`, directories with `0700`.

---

## Security

### Accepted trade-offs (by design)

- **Keychain ACL compatibility mode** — Built-in macOS Keychain sources keep `security add-generic-password -A` by default so upstream CLIs such as Claude Code and Goose can still read swapped items. Any process under your UID (including a malicious `npm postinstall`) could then read the item silently. Set `MAT_KEYCHAIN_RESTRICT_ACL=1` to force no-`-A` writes for a run; if a user/plugin Keychain source needs the legacy broad ACL, set `MAT_KEYCHAIN_ALLOW_ANY_APP=1`. A narrower `-T <path>` whitelist mode remains a future hardening target.

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
- **Credential ownership is judged by filesystem identity, not path spelling.** A plugin cannot reach a built-in CLI's live credentials by declaring an alias for them (directory symlink, file symlink, or hardlink). Paths are compared after resolution, hardlinks are caught on a separate dev/ino axis, and a path that cannot be resolved is rejected rather than allowed. The check runs both when plugins load and again at every read/write/exists/remove, so a source that has *become* an alias since load is refused on its next access. It is not a race-free guarantee: for non-Goose file sources nothing pins the path between that check and the actual open, so an ancestor swapped inside that window is not detected. Goose provider caches additionally pin parent dev/ino and open with `O_NOFOLLOW`.
- Dependencies: `npm audit` clean

  If you manage `~/.config` with stow/chezmoi, note the flip side: Goose provider caches now write to the resolved real location, which may sit inside your dotfiles repo. Confirm that path is in your `.gitignore`.

### Not recommended for

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

You can generate that starter JSON without writing files:

```bash
mkdir -p ~/.multi-account-tool/cli-defs
mat plugin scaffold my-cli > ~/.multi-account-tool/cli-defs/my-cli.json
mat plugin validate ~/.multi-account-tool/cli-defs/my-cli.json
mat plugin validate --json   # validate every installed ~/.multi-account-tool/cli-defs/*.json
```

`mat plugin validate` is a **static** JSON/schema/lint check. It does not read credential files, query Keychain/Secret Service/Windows Credential Manager secrets, or prove that an upstream CLI will prefer the intended credential source. A passing report means **static validation passed**, not that the plugin is security-certified. The JSON report is `schemaVersion: 1`; exit codes are `0` when there are no errors, `1` for validation/read/parse errors, and `2` for usage errors. Risky-but-compatible patterns (for example broad file paths or generic keychain services without `account`) are warnings.

`mat` loads every `*.json` in that directory at startup. Invalid plugins are warned and skipped, and `mat` keeps working. Built-in CLIs (`claude`, `codex`, `gemini`, `aider`, `kimi`, `qwen`, `crush`, `opencode`, `goose`, `grok`) cannot be overridden — id collision is rejected.

Field rules:
- `id`: ASCII letter start, then letters/digits/`_`/`-`, 1~32 chars (must not collide with built-ins).
- `name`: any non-empty string (display label).
- `sources[].type`: `'file'`, `'keychain'` (macOS Keychain), `'os-keyring'` (Linux Secret Service), `'env-secret'` (metadata-only; product runtime blocked), or `'win-credential'` (Windows Credential Manager generic credential primitive).
- `sources[].saveAs`: ASCII filename, 1~64 chars (`[a-zA-Z0-9._-]`).
- `sources[].path` (file): any non-empty string (your filesystem path, `~/` expanded).
- `sources[].service` (keychain/os-keyring): any non-empty credential service name.
- `sources[].account` (keychain/os-keyring, **optional**): scope `mat` to a specific service+account entry. Required for **generic / multi-account services** (e.g., Goose's `goose`/`secrets` or any CLI with multiple entries under the same service) — without it, `mat` may match the wrong account. Validation: non-empty string, no control chars. Omit for single-account services (default behaviour preserved).
- `sources[].backend` (os-keyring, optional): `'auto'` or `'secret-service'`.
- `sources[]` for `type: 'win-credential'`: exact keys only — `type`, `targetName`, `credentialType: 'generic'`, required `account`, required `persist` (`'session' | 'local-machine' | 'enterprise'`), and `saveAs`. Windows lookup identity is `targetName + credentialType`; `account` is a required UserName metadata guard, not a lookup selector. On non-Windows hosts, detector/freshness/doctor/support report this source as unsupported/blocked instead of treating it as ordinary missing. This does **not** claim package-level Windows support, built-in Windows CLI support, Copilot support, or a trusted `mat session` boundary.

Plugins are **profile-swap definitions only**. They cannot define `session`, `sessionRun`, env policy, ambient credential scrub rules, or project override hard-stops, and user plugin CLIs are not trusted `mat session start/run` boundaries.

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
- ~~Session-scoped credential isolation~~ ✅ (v0.4.x — `mat session start/list/stop`: env-injection + copy-isolate, concurrent multi-account; `lterm` profile shim integration is complete in `@ictechgy/lterm` v1.0.25+)
- ~~`mat session run <cli> <profile> -- [cli-args...]` framework~~ ✅ — command-scoped safer-run foundation. ~~OpenCode hard-stop probes~~ ✅; ~~Aider forced config/env-file partial-run~~ ✅. ~~Antigravity auth-store research artifact~~ ✅, but product support remains blocked until upstream documents a stable auth-store, redirect, and recapture contract. See the [Antigravity research note](./docs/superpowers/specs/2026-06-14-antigravity-auth-store-research.md) and the [session-run R&D note](./docs/superpowers/specs/2026-06-12-command-scoped-session-run-rd.md).
- More built-in CLIs — ~~Goose~~ ✅ (v0.4.0 account-scoped Keychain; Linux Secret Service added via the `os-keyring` source type). Copilot / Amp remain deferred — see the [Copilot/Amp research note](./docs/superpowers/specs/2026-06-14-copilot-amp-auth-research.md). Copilot needs explicit account binding, application-state swap, ambient token fallback policy, and Windows Credential Manager support. Amp needs env-secret / command-scoped execution design rather than normal file/keychain profile swap. Cursor Agent: plugin recommended (keychain service name not publicly documented).
- **Goose Linux**: on Linux, mat swaps Goose's default `secret-service` backend (libsecret, GNOME Keyring/KWallet) through the `os-keyring` source (`secret-tool` CLI, `goose`/`secrets`), the `~/.config/goose/*.yaml` files, and the fixed reviewed v1.43 provider-cache files/directories described above. Behavior by keyring configuration:
  - **Default (keyring)**: the os-keyring source is included and requires `secret-tool` (libsecret-tools) + a running keyring daemon. A missing tool or a down/denied daemon produces an **explicit error** — mat does *not* silently fall back to YAML, because Goose accesses the keyring through the libsecret *library* (a separate package from the `secret-tool` CLI), so a missing CLI does not prove the keyring is unused. Silently swapping `secrets.yaml` for an active keyring user would be a wrong-account write. An absent keyring entry (vs. a missing tool) is a normal "not found" and skips to the YAML files.
  - **File backend**: set `GOOSE_DISABLE_KEYRING=1` when Goose is intentionally configured not to use the keyring. mat treats the env var as present-means-disabled (**any value**, including `0`/`false`/empty) — matching Goose's own `env::var(...).is_ok()` check — and then **omits** the keyring source (os-keyring on Linux, Keychain on macOS), while continuing to swap `secrets.yaml`, `config.yaml`, and the fixed provider-cache sources. A `config.yaml`-only `keyring: false` setting is not auto-detected, so set the env var too.
- ~~`lterm claude --profile <name>` shim wrapper~~ ✅ (implemented in `ictechgy/light_terminal` PR #144)

---

## License

MIT — [LICENSE](./LICENSE)
