# multi-account-tool (`mat`)

[한국어](README.ko.md) | English

Switch between multiple AI CLI accounts (Claude Code, Codex, Gemini / Antigravity, Aider, Kimi, Qwen, Crush, OpenCode, Goose) from a single TUI. No more `logout` / `login` shuffles — keep one profile per account and swap in a keystroke. Safe by default: macOS Keychain backups with automatic rollback, atomic file writes, plaintext-credential exclusion paths, OAuth refresh-token rotation awareness with TUI dialog (recapture / discard / cancel).

```
╭ Multi-Account Tool ────────────────────────────────╮
│  AI CLI account switcher                           │
╰─────────────────────────────────────────────────────╯

  > Claude Code            [active: personal] ✓
    Codex CLI              [active: work]     ✓
    Gemini / Antigravity   [active: personal] ✓
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
| Gemini / Antigravity | `~/.gemini/oauth_creds.json`, `google_accounts.json` | File swap |
| Aider | `~/.aider.conf.yml` | File swap |
| Kimi CLI | `~/.kimi/config.toml` | File swap |
| Qwen Code CLI | `~/.qwen/settings.json`, `~/.qwen/.env` | File swap |
| Crush | `~/.config/crush/crush.json`, `~/.local/share/crush/crush.json` | File swap |
| OpenCode | `~/.local/share/opencode/auth.json` (OS-agnostic, XDG standard) | File swap |
| Goose | macOS Keychain (service `goose`, account `secrets`) + `~/.config/goose/secrets.yaml` + `config.yaml` | Multi-source (account-scoped Keychain; Linux needs `GOOSE_DISABLE_KEYRING=1` — see below) |

### OAuth Rotation Safety Matrix

Some CLIs use **OAuth refresh-token rotation** (RFC 6749 best practice): a refresh token may only be used once, after which the provider invalidates it. If `mat` restores an older snapshot of such a token, the provider rejects it as "already used" and the user is forced to re-login. The table below summarises which `mat`-supported CLIs are affected.

| CLI | Auth type | Rotation risk | `mat` safe modes |
| --- | --- | --- | --- |
| Codex CLI | OAuth (`tokens.refresh_token`, `tokens.account_id`) | 🔴 High — confirmed token revocation after stale restore | `mat freshness codex` before swap; `mat exec` for one-shot sessions |
| Gemini / Antigravity | OAuth (`refresh_token` + `google_accounts.json.active`) | 🔴 High | Same as Codex |
| OpenCode | OAuth per provider (`provider.refresh`, `provider.accountId`) | 🔴 High | Same as Codex |
| Claude Code | macOS Keychain (Anthropic OAuth) | 🟢 Mitigated — identity-aware adapter (`subscriptionType` + macOS keychain account) | `mat exec`, and `mat freshness claude` (PR-H adapter, high-confidence rotation classification) |
| Goose | macOS Keychain + `secrets.yaml` / `config.yaml` (provider-routed) | 🟢 Mitigated — identity-aware adapter (provider key matrix + keychain account) | `mat freshness goose` reports per-source result, identity-aware |
| Aider / Kimi / Qwen / Crush | Static API key | 🟢 None | Standard swap is sufficient |

Use `mat freshness [<cli>] [--profile <name>] [--json]` to inspect the live credentials versus the active profile before you swap. Exit code 0 means safe, exit code 1 means `mat` detected `stale` (identity changed or profile missing). For long-running sessions prefer `mat exec`, which automatically restores the previous profile after the command finishes — note that a `SIGKILL` to `mat` itself bypasses restore (see Security section).

> **OAuth rotation handling (PR-G/PR-I\*/PR-H all landed):** the TUI swap path detects freshness drift before swapping and shows an interactive **Recapture / Discard / Cancel** dialog (PR-G). Recapture saves the live credentials into the active profile via `snapshotLiveToProfile` then swaps; Discard skips the auto-snapshot (data loss); Cancel aborts. `mat exec` re-captures the live credentials on exit (PR-I\*) so rotation triggered during the command is preserved in the swap-target profile before restore — protected against `SIGINT`/`SIGTERM`/`SIGHUP` (`SIGKILL` is OS-level untrappable and falls back to stale-recovery on the next `mat` call). Claude/Goose identity-aware adapters (PR-H) classify rotation vs identity change with `high`/`medium` confidence — no more `[low conf]` dialog noise on safe swaps.

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

---

## Usage

```bash
mat
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

# Pair with lterm
lterm send-keys "mat exec claude work -- claude" Enter
```

Behaviour:

- Requires an active profile for `<cli>` already set (use the TUI to capture live credentials first).
- A per-CLI lockfile (`~/.multi-account-tool/locks/<cli>.lock`) prevents two `mat exec` runs from racing on the same CLI. Stale locks from crashed processes are auto-recovered.
- Signals (`SIGINT` / `SIGTERM` / `SIGHUP`) are forwarded to the child; the child's exit code and signal are propagated back.
- **On exit, `mat` re-captures the live credentials into `<profile>` first** (so rotation triggered by `<cmd>` is preserved), then restores the previous active profile. The recapture has a default 10s timeout (`MAT_EXEC_RECAPTURE_TIMEOUT_MS` env override) to bound keychain-prompt hangs.
- The restore step runs in a `finally` block so normal exit, errors, and forwarded signals all trigger it. **A `SIGKILL` (or other untrappable signal: `SIGSEGV` / `SIGBUS`) to `mat` itself bypasses restore** — on the next `mat` invocation, the stale lock is auto-recovered and `mat` writes a stderr warning indicating the live credentials may still belong to `<profile>` rather than the previous active profile (policy B: warn + drop).

This is **temporal isolation**, not session isolation: while the child runs, the OS-global credentials are the `<profile>` ones. Two terminals running different `mat exec` commands serialise via the lock; true per-session isolation is on the roadmap.

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

### `mat freshness` — pre-swap safety check

```bash
mat freshness [<cli>] [--profile <name>] [--json]
```

Compare live credentials with the active (or specified) profile snapshot and report drift before you swap. Useful in CI chains (`mat freshness && deploy.sh`) to block stale-restore incidents (e.g., OAuth `refresh_token` revocation after wrong-profile restore).

```bash
# Quick safety check before a long Claude session
mat freshness claude

# Inspect a specific profile (machine-readable JSON for CI)
mat freshness codex --profile work --json
```

Each source is classified into one of four states — `fresh` (byte-identical), `rotated` (token rotated but identity preserved; safe to swap), `stale` (identity changed — a different account; **swap will revoke**), `inflight` (multi-source CLI partially updated — retry shortly).

Exit codes:

| Code | Meaning |
| --- | --- |
| `0` | All sources are `fresh` or high-confidence `rotated` — safe to swap |
| `1` | One or more sources are `stale`, low-confidence `rotated`, or `inflight` — **fix before swap** |
| `2` | Usage error |
| `74` | Internal check failed (e.g., source read error) |

See the OAuth Rotation Safety Matrix at the top of this README for per-CLI classification confidence.

---

## Data layout

```
~/.multi-account-tool/
├── config.json                   # active profile pointer + flags
└── profiles/
    ├── claude/
    │   ├── personal/
    │   │   ├── credentials.json  # Keychain entry backup (plaintext JSON)
    │   │   └── meta.json
    │   └── work/...
    ├── codex/...
    └── gemini/...
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
- Error messages are redacted (JWT pattern + 50+ char base64-like sequences → `[redacted]`)
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
- Session-scoped credential isolation (different account per `lterm` session)
- More built-in CLIs — ~~Goose~~ ✅ (v0.4.0, account-scoped Keychain). Copilot / Amp are deferred until mat's source abstraction is further extended (Linux Secret Service / Windows Credential Manager source types). Cursor Agent: plugin recommended (keychain service name not publicly documented).
- **Goose limitation**: mat swaps only macOS Keychain (`goose`/`secrets`) and the `~/.config/goose/*.yaml` files. If you run Goose on Linux with the default `secret-service` backend (libsecret, GNOME Keyring/KWallet), mat cannot reach it — disable Goose's keyring (`GOOSE_DISABLE_KEYRING=1` or file backend in `~/.config/goose/config.yaml`) so credentials land in `secrets.yaml`.
- `lterm claude --profile <name>` shim wrapper

---

## License

MIT — [LICENSE](./LICENSE)
