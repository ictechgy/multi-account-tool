# Goose v1.40.0 provider-cache admission

> Historical baseline. The current v1.43 extension is documented in
> [\`goose-v1.43.0-provider-cache.md\`](./goose-v1.43.0-provider-cache.md).

G002 pins the upstream primary source at tag [`v1.40.0`](https://github.com/aaif-goose/goose/releases/tag/v1.40.0), commit [`9081cbd1d7c1856199383abb667ac7276d1794d5`](https://github.com/aaif-goose/goose/tree/9081cbd1d7c1856199383abb667ac7276d1794d5).

The reviewed upstream provider modules use Goose's config directory with these
fixed relative cache targets:

- `gemini_oauth/tokens.json` — [`gemini_oauth.rs`](https://github.com/aaif-goose/goose/blob/9081cbd1d7c1856199383abb667ac7276d1794d5/crates/goose/src/providers/gemini_oauth.rs)
- `chatgpt_codex/tokens.json` — [`chatgpt_codex.rs`](https://github.com/aaif-goose/goose/blob/9081cbd1d7c1856199383abb667ac7276d1794d5/crates/goose/src/providers/chatgpt_codex.rs)
- `kimicode/token.json` — [`kimicode.rs`](https://github.com/aaif-goose/goose/blob/9081cbd1d7c1856199383abb667ac7276d1794d5/crates/goose/src/providers/kimicode.rs)
- `githubcopilot/` — [`githubcopilot.rs`](https://github.com/aaif-goose/goose/blob/9081cbd1d7c1856199383abb667ac7276d1794d5/crates/goose/src/providers/githubcopilot.rs)
- `xai_oauth/tokens.json` — [`xai_oauth.rs`](https://github.com/aaif-goose/goose/blob/9081cbd1d7c1856199383abb667ac7276d1794d5/crates/goose/src/providers/xai_oauth.rs)
- `databricks/oauth/` — [`databricks_auth.rs`](https://github.com/aaif-goose/goose/blob/9081cbd1d7c1856199383abb667ac7276d1794d5/crates/goose/src/providers/databricks_auth.rs)

This is a **path admission**, not a token-schema admission. No raw credentials
or real-user cache was collected. Until a future review adds redacted fixtures
for a provider's stable non-secret identity fields, G002 treats a byte-different
provider cache as opaque, low-confidence `rotated:both`; it never parses or
logs tokens, JWTs, emails, expiry values, or descendant names.
