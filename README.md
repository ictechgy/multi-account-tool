# multi-account-tool (`mat`)

[한국어](README.ko.md) | English

Switch between multiple AI CLI accounts (Claude Code, Codex, Gemini / Antigravity, Aider, Kimi, Qwen, Crush, OpenCode) from a single TUI. No more `logout` / `login` shuffles — keep one profile per account and swap in a keystroke. Safe by default: macOS Keychain backups with automatic rollback, atomic file writes, plaintext-credential exclusion paths.

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

### Switch flow (lossless)

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
2. Press `Enter` on the new profile to make it active
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
- The restore step runs in a `finally` block so normal exit, errors, and forwarded signals all trigger it. **A `SIGKILL` to `mat` itself bypasses restore** — the active pointer would then remain on `<profile>` until you switch back via the TUI.

This is **temporal isolation**, not session isolation: while the child runs, the OS-global credentials are the `<profile>` ones. Two terminals running different `mat exec` commands serialise via the lock; true per-session isolation is on the roadmap.

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

- **Keychain ACL relaxation** — Claude credentials are normally protected by a Keychain ACL that allows only the Claude binary. To avoid Claude losing read access after a swap, `mat` rewrites the entry with `security add-generic-password -A`, which allows any process running as the same user to read it. Any process under your UID (including a malicious `npm postinstall`) could read it silently. An opt-in `-T <path>` whitelist mode is planned for v0.2.

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

See [ROADMAP.md](./ROADMAP.md) for v0.2+ plans:

- ~~Plugin mechanism for community-contributed CLI definitions~~ ✅ (v0.3)
- ~~Aider built-in support~~ ✅ (v0.3) + ~~Kimi / Qwen / Crush / OpenCode~~ ✅ (v0.3.x)
- Session-scoped credential isolation (different account per `lterm` session)
- More built-in CLIs — ~~Goose~~ ✅ (v0.4-pre, account-scoped Keychain). Copilot / Amp are deferred until mat's source abstraction is further extended (Linux Secret Service / Windows Credential Manager source types). Cursor Agent: plugin recommended (keychain service name not publicly documented).
- **Goose limitation**: mat swaps only macOS Keychain (`goose`/`secrets`) and the `~/.config/goose/*.yaml` files. If you run Goose on Linux with the default `secret-service` backend (libsecret, GNOME Keyring/KWallet), mat cannot reach it — disable Goose's keyring (`GOOSE_DISABLE_KEYRING=1` or file backend in `~/.config/goose/config.yaml`) so credentials land in `secrets.yaml`.
- `lterm claude --profile <name>` shim wrapper

---

## License

MIT — [LICENSE](./LICENSE)
