# Goose v1.43.0 provider-cache admission

G004 extends the original v1.40 path audit at
[`goose-v1.40.0-provider-cache.md`](./goose-v1.40.0-provider-cache.md).
The current pin is tag [`v1.43.0`](https://github.com/aaif-goose/goose/releases/tag/v1.43.0),
commit [`5a9eb7edea1e081e2d54473ae41481f0289b826a`](https://github.com/aaif-goose/goose/tree/5a9eb7edea1e081e2d54473ae41481f0289b826a).

The six previously admitted cache artifacts remain unchanged. v1.43.0 adds one
reviewed fixed file:

- `huggingface/oauth/tokens.json` —
  [local-inference source](https://github.com/aaif-goose/goose/blob/5a9eb7edea1e081e2d54473ae41481f0289b826a/crates/goose-local-inference/src/huggingface_auth.rs) and
  [provider source](https://github.com/aaif-goose/goose/blob/5a9eb7edea1e081e2d54473ae41481f0289b826a/crates/goose/src/providers/huggingface_auth.rs)

The same upstream source also permits `HF_TOKEN` as a fallback secret channel,
so `mat` reports that env name as an informational ambient bypass warning.

This remains a **path admission**, not a token-schema admission. `mat` never
parses or logs Hugging Face token fields. The file uses the existing Goose
provider no-follow/private-parent protections, and freshness is conservative:
byte-identical is `fresh`; any difference is opaque low-confidence
`rotated:both`.
