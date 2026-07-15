# Upstream compatibility audit — 2026-07-15

This audit records the exact upstream baselines used for `multi-account-tool`
v0.8.0. It is a compatibility-boundary review, not a claim that every upstream
feature is supported. Runtime support remains limited to the sources and
session boundaries declared in `src/core/cli-defs.ts` and
`src/core/support.ts`.

No live credential file, keyring item, or real-user token was inspected.

## Results

| CLI | Audited baseline | Result |
| --- | --- | --- |
| Claude Code | [v2.1.210](https://github.com/anthropics/claude-code/releases/tag/v2.1.210) | Existing macOS Keychain / file-source boundary retained. No new source admitted. |
| Codex CLI | [rust-v0.144.4](https://github.com/openai/codex/releases/tag/rust-v0.144.4) | Existing `CODEX_HOME` and `auth.json` boundary retained. No new source admitted. |
| Gemini CLI | [v0.50.0](https://github.com/google-gemini/gemini-cli/releases/tag/v0.50.0) | Existing `GEMINI_CLI_HOME` / `.gemini` boundary retained. Personal-tier availability changes do not create an Antigravity credential contract. |
| Aider | [v0.86.0](https://github.com/Aider-AI/aider/releases/tag/v0.86.0) | Command-scoped partial support retained; no credential-directory session boundary claimed. |
| Kimi CLI | [1.48.0](https://github.com/MoonshotAI/kimi-cli/releases/tag/1.48.0) | Existing `KIMI_SHARE_DIR` and `config.toml` boundary retained. |
| Qwen Code | [v0.19.10](https://github.com/QwenLM/qwen-code/releases/tag/v0.19.10), commit [`095bd160…`](https://github.com/QwenLM/qwen-code/tree/095bd160918086a3a33192133e7923635f08f973) | `QWEN_HOME`, dotenv/settings precedence, and custom provider `envKey` routes remain broad. Static provider env warnings were refreshed; `mat session run qwen` remains disabled. |
| Crush | [v0.84.1](https://github.com/charmbracelet/crush/releases/tag/v0.84.1) | GitHub file comparison against the existing `7b24cc09…` source pin reported zero changed files. Existing conservative OAuth freshness contract retained. |
| OpenCode | [v1.18.1](https://github.com/anomalyco/opencode/releases/tag/v1.18.1), commit [`99f638d8…`](https://github.com/anomalyco/opencode/tree/99f638d8293f6985726ba509da602296c4963497) | Canonical upstream is `anomalyco/opencode`; auth remains `Global.Path.data/auth.json`. Existing XDG boundary retained. |
| Goose | [v1.43.0](https://github.com/aaif-goose/goose/releases/tag/v1.43.0), commit [`5a9eb7e…`](https://github.com/aaif-goose/goose/tree/5a9eb7edea1e081e2d54473ae41481f0289b826a) | Added the exact Hugging Face OAuth cache file and `HF_TOKEN` ambient warning. Cache contents remain opaque. |
| Grok Build | local stable `grok 0.2.101 (5bc4b5dfadcf)` plus [xAI Build docs](https://docs.x.ai/build/overview) | Existing `~/.grok/auth.json` profile-swap-only boundary retained. Config/env/project/MCP channels still block session isolation. |
| Google Antigravity | [1.1.2](https://github.com/google-antigravity/antigravity-cli/releases/tag/1.1.2), commit [`b27d51db…`](https://github.com/google-antigravity/antigravity-cli/tree/b27d51dbe52b1b0686b501302b9c4a353d84661d) | Still blocked. OAuth UX changes do not document a stable store, redirect, or recapture contract that `mat` can safely use. |

## Qwen v0.19.10 boundary

The current source still resolves the global directory from `QWEN_HOME`
([`storage.ts`](https://github.com/QwenLM/qwen-code/blob/095bd160918086a3a33192133e7923635f08f973/packages/core/src/config/storage.ts))
and discovers user/project dotenv inputs
([`environment.ts`](https://github.com/QwenLM/qwen-code/blob/095bd160918086a3a33192133e7923635f08f973/packages/cli/src/config/environment.ts)).
Authentication can also use configured `modelProviders[].envKey`
([`auth.ts`](https://github.com/QwenLM/qwen-code/blob/095bd160918086a3a33192133e7923635f08f973/packages/cli/src/config/auth.ts)).

Therefore:

- profile swap and `session start` remain advisory,
- `session run` remains unsupported,
- `mat` warns for the current built-in provider API-key env names and
  `QWEN_CUSTOM_API_KEY_*`, but does not pretend it can enumerate arbitrary
  user-defined `envKey` values without reading settings.

## Goose v1.43.0 delta

Goose v1.43.0 adds the fixed relative cache path
`huggingface/oauth/tokens.json` and a fallback secret key named `HF_TOKEN`
in both the local-inference and provider implementations:

- [`crates/goose-local-inference/src/huggingface_auth.rs`](https://github.com/aaif-goose/goose/blob/5a9eb7edea1e081e2d54473ae41481f0289b826a/crates/goose-local-inference/src/huggingface_auth.rs)
- [`crates/goose/src/providers/huggingface_auth.rs`](https://github.com/aaif-goose/goose/blob/5a9eb7edea1e081e2d54473ae41481f0289b826a/crates/goose/src/providers/huggingface_auth.rs)

`mat` admits only the exact file:

`~/.config/goose/providers/huggingface/oauth/tokens.json`

saved as:

`goose-provider-huggingface-oauth-tokens.json`

This reuses the existing no-follow, single-link, private-parent Goose provider
file protections. It is a **path admission only**. Equal bytes are fresh;
different bytes are low-confidence `rotated:both` and require attention.
No access token, refresh token, expiry, email, JWT, or account identity is
parsed or logged.

## Deliberately unchanged boundaries

- No provider-directory discovery.
- No new dependency.
- No Goose, Qwen, Grok, or Antigravity session capability.
- No Windows Goose support.
- No schema-derived identity claim for any fixed Goose provider cache.
- No claim that Gemini personal-tier availability implies Antigravity credential compatibility.
