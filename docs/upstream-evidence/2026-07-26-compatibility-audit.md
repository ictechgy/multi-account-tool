# Upstream compatibility audit — 2026-07-26

Baselines used for `multi-account-tool` v0.8.1. This is a compatibility-boundary
review plus one **path correction**, not a claim that every upstream feature is
supported. Runtime support remains limited to the sources and session boundaries
declared in `src/core/cli-defs.ts`, `src/core/goose-provider-cache.ts`, and
`src/core/support.ts`.

No live credential file, keyring item, or real-user token was inspected.

## 1. Correction — Goose provider cache paths were one directory too deep

Releases 0.7.x–0.8.0 declared the seven Goose provider OAuth cache artifacts
under `~/.config/goose/providers/…`. **That segment does not exist upstream.**
Because the same wrong string was restated in three places (`cli-defs.ts` source
definitions, the `sources.ts` hardening guard, the `doctor.ts` diagnostic guard)
and the tests built fixtures at the same wrong path, every test passed while
`mat` never captured or restored a single Goose provider cache. A profile switch
reported success while the previous account's provider token stayed live — a
fail-closed isolation violation.

Upstream resolves these caches as `Paths::in_config_dir(sub)` =
`config_dir().join(sub)`, and `config_dir()` is `~/.config/goose` via etcetera
`choose_app_strategy`:

- [`crates/goose/src/providers/provider_secrets.rs`](https://github.com/aaif-goose/goose/blob/5a9eb7edea1e081e2d54473ae41481f0289b826a/crates/goose/src/providers/provider_secrets.rs) — `PROVIDER_CACHE_SECRET_DEFINITIONS` = `gemini_oauth/tokens.json`, `chatgpt_codex/tokens.json`, `kimicode/token.json`, `githubcopilot` (dir), `xai_oauth/tokens.json`, `databricks/oauth` (dir; `databricks` and `databricks_v2` share it)
- [`crates/goose/src/providers/huggingface_auth.rs`](https://github.com/aaif-goose/goose/blob/5a9eb7edea1e081e2d54473ae41481f0289b826a/crates/goose/src/providers/huggingface_auth.rs) — `HUGGINGFACE_OAUTH_CACHE_PATH = "huggingface/oauth/tokens.json"`

Verified absent at tags v1.35.0, v1.38.0, v1.40.0, v1.42.0, v1.43.0 (the audited
commit `5a9eb7e`), and v1.44.0. GitHub code search
`repo:aaif-goose/goose "providers/gemini_oauth"` returns **0 results**.

This repository's own evidence file
[`goose-v1.40.0-provider-cache.md`](./goose-v1.40.0-provider-cache.md) recorded
the relative paths **correctly** from the start — only the implementation
diverged. `2026-07-15-compatibility-audit.md` repeated the implementation's error
and carries an erratum pointer.

Corrected admitted paths (now defined once, in `src/core/goose-provider-cache.ts`,
with the hardening guards deriving membership from the same array):

```
~/.config/goose/gemini_oauth/tokens.json
~/.config/goose/chatgpt_codex/tokens.json
~/.config/goose/kimicode/token.json
~/.config/goose/githubcopilot/            (bounded directory)
~/.config/goose/xai_oauth/tokens.json
~/.config/goose/databricks/oauth/         (bounded directory)
~/.config/goose/huggingface/oauth/tokens.json
```

`saveAs` names are unchanged, so profile layout, identity mapping
(`profile-identity.ts`) and freshness (`freshness-adapters/goose.ts`) are
unaffected. Still a **path admission only** — no discovery, no schema admission,
no session capability.

### Migration consequence

Profiles captured before 0.8.1 contain no provider artifacts. Restore does not
delete a live file that the profile does not carry, so the previous account's
provider token survives the first switch. 0.8.1 surfaces this as
`RestoreResult.carriedOver` and a distinct warning line instead of folding it
into the neutral "not in profile, skipped" notice.

**Recovery is order-dependent — do not treat this as a blanket "re-snapshot
everything" instruction.** The provider cache always belongs to whichever account
is logged in to Goose *right now*, so:

- Re-capture a Goose profile only **while that profile's own account is the one
  currently logged in**. Once you have logged in as that account, capturing is the
  correct action.
- **Never re-capture immediately after a switch reported a carried-over
  artifact.** At that moment the live cache still belongs to the *previous*
  account, so capturing would store the wrong account's token into the profile you
  just switched to — precisely the cross-account write this release exists to
  prevent.
- If you are unsure which account the live artifact belongs to, check with
  `mat freshness` / `mat doctor` before capturing anything.

`formatSwitchResult`, README/README.ko, CHANGELOG, and the `support goose`
drift-contract risks all state this same order; a contract test fails if the
support text regresses to unconditional re-capture advice.

### Directory mode is umask-dependent upstream

Goose creates the provider cache parent directories with a bare
`create_dir_all(parent)` and **no explicit mode** — `gemini_oauth.rs:160`,
`xai_oauth.rs:113`, `chatgpt_codex.rs:334`, `kimicode.rs:119`,
`huggingface_auth.rs:206` — so the mode is `0o777 & ~umask`. Token *files* are
explicitly `0600` (`huggingface_auth.rs:218`, `kimicode.rs:125`, plus the `0600`
assertions in the gemini/xai/chatgpt_codex tests). MAT's private-parent check
rejects `mode & 0o022`, so a group-writable umask (`0775`) fails closed.

This is **not new in 0.8.1**: the 0.8.0 code already routed the (bogus)
`providers/` paths through the same hardening walk, and that walk lstats
`~/.config` and `~/.config/goose` *before* reaching the missing segment. Measured
against the shipped 0.8.0 build with a synthetic HOME, `~/.config/goose` at
`0775` already threw `unsafe Goose provider cache parent`. `git tag --contains 7b579da`
= `v0.8.0`. What 0.8.1 newly exposes is the mode of the *leaf* provider
directories, which only affects users who actually have these caches.

Frequency is **not established**. On `fedora:latest` a UID-1000 user with a
user-private group measured `umask 0022` for both login and interactive shells and
`0755` directories (passes); `/etc/profile` carries no umask logic and
`/etc/bashrc` only has an `[ \`umask\` -eq 0 ] && umask 022` guard. However
`/etc/login.defs` ships `UMASK 022` **with `USERGROUPS_ENAB yes`**, and
`pam_umask` in usergroups mode drops the group bits (022 → 002) when UID == GID
and the user name equals the group name. `pam_umask` is not referenced in any
`/etc/pam.d` stack in the container image, so the container measurement does not
settle real desktop/SSH logins. Treated as unresolved; MAT ships fail-closed with
attribution rather than guessing a grade.

MAT does not chmod user-owned directories: POSIX offers no portable, cheap proof
that a group has exactly one member, so MAT cannot distinguish a user-private
group from a genuinely shared one, and silently widening or narrowing permissions
is a mutation the user's switch request did not authorize. Diagnosis plus a
remediation hint only.

## 2. No-change sweep

| CLI | Baseline → current | Result |
| --- | --- | --- |
| Claude Code | v2.1.210 → [v2.1.220](https://github.com/anthropics/claude-code/releases/tag/v2.1.220) | Keychain / `~/.claude/.credentials.json` boundary retained. Closed source; no contract change observed. |
| Codex CLI | rust-v0.144.4 → [rust-v0.145.0](https://github.com/openai/codex/releases/tag/rust-v0.145.0) | `CODEX_HOME` + `auth.json` retained. `CODEX_HOME/.credentials.json` (MCP OAuth) and the auth-keyring store mode already existed at the 0.144.4 baseline — not a new delta. |
| Gemini CLI | v0.50.0 → [v0.52.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.52.0) | No credential-path change; the only auth-adjacent diff is under `tools/caretaker-agent/**`. |
| Aider | v0.86.0 (unchanged) | No release since 2025-08. Command-scoped partial support retained. |
| Kimi CLI | 1.48.0 → [1.49.0](https://github.com/MoonshotAI/kimi-cli/releases/tag/1.49.0) | `get_share_dir()` still honours `KIMI_SHARE_DIR` and falls back to `~/.kimi` (`src/kimi_cli/share.py`); config remains `config.toml`. |
| Qwen Code | v0.19.10 → [v0.21.0](https://github.com/QwenLM/qwen-code/releases/tag/v0.21.0) | `QWEN_HOME`, `QWEN_RUNTIME_DIR`, and the legacy `<homedir>/.qwen/.env` fallback were **already present** at the audited 0.19.10 baseline, so no new delta. `mat session run qwen` stays unsupported. |
| Crush | v0.84.1 → [v0.87.0](https://github.com/charmbracelet/crush/releases/tag/v0.87.0) | `GlobalConfig()` / `GlobalConfigData()` paths and the `providers.<id>.oauth` shape retained. MCP server tokens persist as `mcp.<name>.oauth_token` **inside the already-captured crush.json files**. See §3. |
| OpenCode | v1.18.1 → [v1.18.5](https://github.com/anomalyco/opencode/releases/tag/v1.18.5) | `Global.Path.data/auth.json` + `OPENCODE_AUTH_CONTENT` unchanged. |
| Goose | v1.43.0 → [v1.44.0](https://github.com/aaif-goose/goose/releases/tag/v1.44.0) | No new fixed cache path. The new generic OAuth persistence stores under secret key `oauth_creds_<name>` (`crates/goose/src/oauth/persist.rs`), which lands in the keyring / `secrets.yaml` MAT already captures. `kimicode/device_id` exists but is a device id, not a credential — not admitted. |
| Grok Build | local `0.2.101` → local `0.2.112` | Closed source; not source-verifiable. `~/.grok/auth.json` profile-swap-only boundary retained. |
| Google Antigravity | 1.1.2 → 1.1.7 | Still known-blocked. The distribution repository ships no source and documents no stable credential store; 1.1.3–1.1.7 notes mention MCP OAuth fixes but no store, redirect, or recapture contract MAT could safely admit. |

## 3. Crush pin refresh (documentation only)

Crush v0.87.0's `internal/oauth/token.go` adds `Client *OAuthClient`
(`json:"client,omitempty"`) to `Token` and makes `refresh_token` `omitempty`.
This is **non-functional for MAT**: `compareCrush()` compares raw bytes only, and
`isAdmittedOauthShape()` / `findAdmittedOauthProviders()` are test- and
future-facing exports that are not on the compare path. The adapter's pin comment
and `CRUSH_ADMISSION` metadata are refreshed; `OAUTH_REQUIRED_FIELDS` and the
admission logic are deliberately unchanged — extending the admitted shape
requires a separate plan with redacted fixtures.

## 4. GLM (Z.ai) — builtin CLI support declined

There is no first-party GLM agentic coding CLI to support. npm `glm` is an
unrelated statistics package; `@zai-org/glm-cli`, `@z-ai/glm-cli`,
`@zhipuai/glm-cli`, and `@zai-org/cli` do not exist; `zai-cli` 1.1.0 is a Z.AI
vision / web-search utility, not an agentic CLI with its own credential store;
and no `zai-org` CLI repository exists. Per the Z.ai docs
(`docs.z.ai/devpack/tool/claude`), the GLM Coding Plan integrates with Claude
Code through **environment variables only** (`ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL`), and its
other documented targets (crush, cline, roo, kilo via
`api.z.ai/api/coding/paas/v4`; goose via `api.z.ai/api/anthropic`) are configured
inside each tool's own config file — which MAT already captures for crush and
goose.

A `glm` CliDef would therefore admit **zero** credential files, keychain items,
or keyring entries. That is exactly the speculative provider expansion this
project forbids, so it is declined. What GLM does expose is a real gap in the
ambient-warning surface, closed here:

| Rule | Added | Basis |
| --- | --- | --- |
| `claude` | `ANTHROPIC_BASE_URL` | A base-URL redirect routes the whole session to a different provider/account while MAT reports the profile as swapped. MAT already warned on `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` but not on the destination. **Basis is indirect**: the Z.ai integration sets this variable; a first-party statement that Claude Code reads it has not been cited here. |
| `goose` | `ANTHROPIC_HOST` | Direct evidence: [`anthropic_def.rs:38-40`](https://github.com/aaif-goose/goose/blob/v1.44.0/crates/goose/src/providers/anthropic_def.rs) reads `config.get_param("ANTHROPIC_HOST")` (default `https://api.anthropic.com`), and [`config/base.rs:733-738`](https://github.com/aaif-goose/goose/blob/v1.44.0/crates/goose/src/config/base.rs) shows `get_param` checking `env::var(KEY.to_uppercase())` **first** and returning immediately — so env outranks the captured `config.yaml`. Goose does **not** read `ANTHROPIC_BASE_URL`; warning on that name for goose would be a false warning while leaving the real bypass channel uncovered. |
| `goose` | `GOOSE_PATH_ROOT`, `XDG_CONFIG_HOME` | `config_dir()` resolver inputs. If either is set, MAT's fixed `~/.config/goose/**` paths all become absent, absent sources are skipped, and a switch reports success while swapping nothing — the same silent-failure class as the corrected `providers/` defect. A relocated Goose config directory is unsupported; the warning is mitigation, not a fix. |

Deliberately excluded:

- `ANTHROPIC_DEFAULT_{OPUS,SONNET,HAIKU}_MODEL` — MAT captures no Claude routing
  artifact, so there is nothing an env model override can contradict. (The
  existing `GOOSE_MODEL` warning is not the same case: MAT *does* capture
  `goose-config.yaml`.)
- `ANTHROPIC_API_VERSION` — a protocol knob, not an account boundary.

Recorded but **not** acted on: `ANTHROPIC_API_KEY` is warned under `claude`,
`qwen`, and `goose`, so by the same reasoning a destination-redirect variable
belongs wherever an `ANTHROPIC_*` credential is warned. The qwen, crush, and
opencode destination channels are unverified, so they are noted here rather than
expanded speculatively.

## 5. Deliberately unchanged boundaries

- No provider-directory discovery, no new dependency.
- No Goose, Qwen, Grok, or Antigravity session capability.
- No Windows Goose support.
- No schema-derived identity claim for any fixed Goose provider cache.
- No Crush OAuth shape extension.
- No automatic permission changes to directories MAT does not own.
