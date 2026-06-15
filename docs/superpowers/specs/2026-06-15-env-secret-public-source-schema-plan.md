# Env-secret public source/schema exposure plan — RALPLAN gate (2026-06-15)

## Summary

This document is a **RALPLAN-backed design/implementation plan** for a public `env-secret` source/schema. The follow-up implementation now accepts a metadata-only public schema and pairs it with tested runtime hard-stops. It intentionally does **not** add profile UX, product storage, command injection, built-in CLI support, product env-secret injection, or Amp/Copilot support.

The purpose was to make the code PR reviewable before parser acceptance: the schema shape, identity rules, consumer hard-stops, and verification matrix are defined here. The implementation outcome is parser acceptance for safe metadata only, with existing product operations refusing the source before value handling.

Backend custody is separately selected by the companion custody-selection contract, and the first internal Linux Secret Service backend spike exists under metadata-only proof rules. The public schema exposes only the `linux-secret-service` backend kind and still does not open product storage or injection.

GitHub Copilot CLI (`copilot`) and Amp (`amp`) remain blocked for builtin `mat` profile-swap, freshness, `mat exec`, `mat session start`, and `mat session run` product support.

## RALPLAN consensus result

- Planner decision for the plan phase: choose a docs-first public schema plan; do not expose plugin schema until every `Source` consumer has tested env-secret semantics or tested metadata-only hard-stops.
- Architect R1 review: **APPROVE** — the docs-first gate was architecturally justified because `Source` feeds live read/write/exists paths; accepting schema without consumer behavior would create a product surface before custody and runtime semantics exist.
- Critic R1 review: **APPROVE** — principles, alternatives, pre-mortem, test plan, and verification are concrete.
- Follow-up implementation decision: expose parser/schema only with all-consumer metadata-only hard-stops; do not imply product runtime support.

## Current code boundary

Current code accepts `env-secret` as safe metadata only:

- `src/core/types.ts` includes `EnvSecretSource` in the public `Source` union.
- `src/core/cli-defs-plugin.ts` accepts plugin `type: 'env-secret'` only after draft validation, `accountKey` presence, and public backend validation.
- Public backend acceptance is limited to `backend.kind: 'linux-secret-service'`; the internal `synthetic` backend remains test-only and is rejected by the plugin parser.
- `src/core/env-secret-source.ts` centralizes safe metadata, validation, and typed `unsupported-env-secret-source` refusals.
- `src/core/sources.ts`, `src/core/detector.ts`, `src/core/freshness.ts`, `src/core/doctor.ts`, `src/core/switcher.ts`, `src/core/exec.ts`, `src/core/session.ts`, and `src/core/support.ts` either throw a sanitized typed refusal or report metadata-only blocked/not-checked/unsupported status. Detector returns per-CLI `unsupported` metadata so one env-secret plugin does not break unrelated first-import detection.
- Tests pin public schema acceptance, synthetic backend rejection, raw handle/account redaction, and hard-stops across source, detector, freshness, doctor, snapshot/restore/switch, session, and support surfaces.

## Product boundary

This implementation does **not** add any of the following behavior:

- Profile add/import/update/delete/rotate/export/backup UX.
- Product storage, read, write, update, rotate, delete, or metadata-list behavior.
- Product environment injection for `mat exec` or `mat session run`.
- Freshness value comparison, recapture, audit, or masking code for env-secret values.
- `amp` or `copilot` entries in `BUILTIN_CLI_DEFS`.
- Platform Keychain, Windows Credential Manager, external-provider, encrypted-file, or plaintext-file product backend implementation.
- Real secret values, token-shaped examples, hashes, fingerprints, raw credential-store output, or token-printing helper output.

## Public source schema

The public metadata-only source kind has the following shape. It is non-product for value custody/injection until a later reviewed runtime PR replaces hard-stops.

| Field | Requirement |
| --- | --- |
| `type` | Literal `env-secret`; it must not be an alias for `file`, `keychain`, or `os-keyring`. |
| `envName` | Canonical environment variable name. It must satisfy the internal env-name rules and is metadata, not proof of ownership. |
| `saveAs` | Stable source identity/reporting key. For env-secret it is **not** a profile file containing a value. |
| `backend.kind` | Only `linux-secret-service` is public today. Public schema must not expose test-only synthetic storage unless a future PR makes that an explicit reviewed decision. |
| `backend.handle` | Opaque storage reference. It is not a value, account proof, hash, or fingerprint. |
| `accountKey` | Required metadata for upstream account binding. It must never contain secret material and cannot prove ownership by itself. |

### Prohibited fields

The public schema must reject any field that would embed or imply secret material, including:

- direct secret values,
- default/fallback values,
- parent-environment capture directives,
- plaintext storage knobs,
- file paths used as value fallback,
- hashes, fingerprints, prefixes, suffixes, lengths, or sample tokens,
- command output or credential-store output as evidence.

## Identity and uniqueness rules

Code must treat identity as a composition of safe metadata, not as a value observation:

- `saveAs` remains the report/profile-source identity used by existing source arrays and diagnostics.
- `(cliId, profileName, envName, accountKey?)` identifies the profile-owned child-environment binding.
- `(backend.kind, backend.handle)` identifies the storage reference, not the account or secret.
- Duplicate `saveAs` values inside one CLI definition must be rejected.
- Duplicate normalized `envName` values inside one CLI/profile binding set must be rejected before runtime. Windows-style case-insensitive comparisons must be tested separately from POSIX-style comparisons.
- Backend handle reuse must be explicit and tested; accidental reuse across profiles or accounts is a hard-stop.

## No schema-only PR rule

The public parser/schema PR must not land by itself. It must include, in the same PR, one of these reviewed outcomes for every existing `Source` consumer:

1. Correct env-secret behavior for that consumer, or
2. A tested metadata-only hard-stop/refusal result.

This implementation chooses option 2 everywhere: a parser that accepts `type: 'env-secret'` while detector, freshness, switch, snapshot, restore, `mat exec`, or `mat session run` still treat it as ordinary missing/stale credentials is unsafe and must be rejected.

## Runtime consumer matrix

| Consumer | Current behavior |
| --- | --- |
| `readSource` / `writeSource` | Throws sanitized typed refusal before value handling. |
| `sourceExists` / detector | `sourceExists` throws sanitized typed refusal; detector reports per-CLI `unsupported` metadata instead of reporting ordinary missing credentials or failing unrelated CLIs. |
| Freshness | Reports `unsupported` with stable reason metadata, not `fresh`, `stale`, value-diff, hash, fingerprint, or live comparison. |
| Doctor/support/preflight | Reports safe metadata-only blocked/not-checked/unsupported status. |
| Snapshot/restore/switch | Hard-stops until at-rest backend custody and explicit profile binding are implemented. |
| Profile export/backup | Must exclude values by default and include only metadata/relink requirements unless a separate encrypted-export design is approved. |
| `mat exec` | Explicitly blocks before lock/switch/spawn, including already-active no-op swap paths; injection requires later storage, scrub, masking, audit, and CLI-specific hard-stop tests. |
| `mat session run` | Blocks in session planning/preflight; injection requires later `mat exec`-equivalent runtime plus command-scoped session invariants. |
| `mat session start` | Blocks in session planning; a long-lived shell remains out of scope for env-secret ownership claims. |

### Typed refusal shape

Code uses a stable typed refusal shape rather than overloading missing/stale states. At minimum it should include:

- a kind/code such as `unsupported-env-secret-source`,
- safe metadata (`saveAs`, `envName`, `cliId`, `profileName` when available, backend kind),
- a sanitized human detail,
- no value, hash, fingerprint, command output, or token-shaped sample.

## Implementation test requirements

### Unit

- Internal draft validation rejects invalid env names, duplicate `saveAs`, duplicate normalized env names, unsupported backend kinds, prohibited fields, unsafe display characters, and any plaintext fallback knob.
- Public parser acceptance keeps those checks and pairs them with all consumer hard-stops or implemented semantics.
- Tests now assert public `linux-secret-service` schema acceptance and continued rejection of internal `synthetic`.

### Integration

- Detector, freshness, doctor/preflight, snapshot, restore, switch, `mat exec`, and `mat session run` each prove either correct env-secret behavior or metadata-only refusal.
- Parent environment variables are never captured as profile-owned evidence.
- Backend unavailable, locked, denied, unsupported, ambiguous, and partial-delete states fail closed before storage or injection.

### E2E

- A synthetic CLI may report only presence/absence of a received environment variable in a later runtime PR; output containing secret material is invalid evidence.
- `mat session start` remains unsupported for env-secret.
- Amp and Copilot prototypes remain blocked until their CLI-specific hard-stop matrices pass.

### Observability

- Logs, audit events, debug output, docs, PR text, and review artifacts contain metadata and reason codes only.
- No secret values, token-shaped examples, hashes, fingerprints, prefixes, suffixes, lengths, raw credential-store output, or command output containing secret material.

## Verification for this implementation PR

- `npm run build:docs`
- `npx vitest run tests/core/cli-defs-plugin.test.ts tests/core/env-secret.test.ts tests/core/sources.test.ts tests/core/detector.test.ts tests/core/freshness.test.ts tests/core/doctor.test.ts tests/core/switcher.test.ts tests/core/session.test.ts tests/core/support.test.ts tests/core/exec.test.ts`
- `npm run typecheck`
- `npm test`
- Static scan proving product support remains closed: no builtin `env-secret` CLI, no Amp/Copilot wiring, no command injection, no profile value storage, and no strict backend helper calls from product flows.
- Token-shaped addition scan over docs and roadmap changes.

## Stop conditions

Keep public env-secret schema/runtime blocked if any of these are true:

- Parser acceptance would land without runtime semantics or tested hard-stops for all `Source` consumers.
- Storage backend behavior is unspecified, unsupported, untested, or can silently degrade to plaintext.
- The Linux Secret Service proof contract has not passed, or another backend has not replaced it through a reviewed custody decision.
- Parent-shell environment capture is treated as profile ownership proof.
- A token value, token-shaped placeholder, hash, fingerprint, command output, or raw credential-store output is required as proof.
- `mat exec` or `mat session run` would inject into an arbitrary executable or shell.
- CLI-specific config/MCP/plugin/provider override channels are unresolved for the selected CLI.
- PR text implies this plan implemented public schema or product support.

## Follow-ups

1. ✅ Backend custody selection/proof contract documented; first code spike is Linux Secret Service.
2. ✅ Internal Linux Secret Service backend spike under the custody proof contract, completed before public parser opening.
3. ✅ Public env-secret parser plus all-consumer metadata-only hard-stop PR based on this plan.
4. Synthetic command-scoped runtime PR only after schema/runtime hard-stops and storage backend proof are approved.
5. Amp config hard-stop matrix, then Amp prototype.
6. Copilot platform/app-state/ambient-token integration, then Copilot prototype.
