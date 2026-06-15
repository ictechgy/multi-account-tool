# Env-secret public source/schema exposure plan — RALPLAN gate (2026-06-15)

## Summary

This document is a **RALPLAN-backed design/implementation plan** for a future public `env-secret` source/schema. It intentionally does **not** add a `SourceType`, plugin schema acceptance, profile UX, product storage, command injection, built-in CLI support, freshness adapter, or real backend.

The purpose is to make the next code PR reviewable before any parser acceptance exists: the future schema shape, identity rules, consumer hard-stops, and verification matrix are defined here, while current product code continues to reject `type: 'env-secret'` declarations.

GitHub Copilot CLI (`copilot`) and Amp (`amp`) remain blocked for builtin `mat` profile-swap, freshness, `mat exec`, `mat session start`, and `mat session run` product support.

## RALPLAN consensus result

- Planner decision: choose a docs-only public schema plan now; do not expose plugin schema until every `Source` consumer has tested env-secret semantics or tested metadata-only hard-stops.
- Architect R1 review: **APPROVE** — docs-only is architecturally justified because `Source` currently feeds live read/write/exists paths; accepting schema now would create a product surface before custody and runtime semantics exist.
- Critic R1 review: **APPROVE** — principles, alternatives, pre-mortem, test plan, and verification are concrete; keep parser/schema boundaries explicitly rejected in this PR.

## Current code boundary

Current code remains intentionally closed:

- `src/core/types.ts` exposes only `file`, `keychain`, and `os-keyring` source types.
- `src/core/cli-defs-plugin.ts` rejects plugin source types outside that set, with an explicit closed parser/runtime diagnostic for `type: 'env-secret'`.
- `src/core/env-secret.ts` contains internal draft validation and metadata-only refusal helpers for future planning/tests; those helpers are not plugin parser acceptance and do not route through product source operations.
- The internal synthetic backend remains test-only and must not appear in public docs, runtime UX, or accepted plugin schema as product support.
- `tests/core/env-secret.test.ts` and `tests/core/cli-defs-plugin.test.ts` pin rejection of `type: 'env-secret'` declarations.
- `src/core/sources.ts` maps each source to live read/write/exists behavior; env-secret cannot be safely represented by the current string-oriented source operations without a separate runtime contract.

## Product boundary

This plan does **not** add any of the following behavior:

- `SourceType` or `Source` union changes.
- Plugin JSON schema acceptance for `env-secret` declarations.
- Profile add/import/update/delete/rotate/export/backup UX.
- Product storage, read, write, update, rotate, delete, or metadata-list behavior.
- Product environment injection for `mat exec` or `mat session run`.
- Freshness, doctor, preflight, recapture, audit, or masking code.
- `amp` or `copilot` entries in `BUILTIN_CLI_DEFS`.
- Platform Keychain, Secret Service, Windows Credential Manager, external-provider, encrypted-file, or plaintext-file backend implementation.
- Real secret values, token-shaped examples, hashes, fingerprints, raw credential-store output, or token-printing helper output.

## Future source schema candidate

A future implementation may introduce a distinct public source kind with the following shape. This table is normative for the next implementation plan but remains non-product until a code PR implements validation and hard-stops.

| Field | Future requirement |
| --- | --- |
| `type` | Literal `env-secret`; it must not be an alias for `file`, `keychain`, or `os-keyring`. |
| `envName` | Canonical environment variable name. It must satisfy the internal env-name rules and is metadata, not proof of ownership. |
| `saveAs` | Stable source identity/reporting key. For env-secret it is **not** a profile file containing a value. |
| `backend.kind` | Only explicitly implemented backend kinds are allowed. Public schema must not expose test-only synthetic storage unless a future PR makes that an explicit reviewed decision. |
| `backend.handle` | Opaque storage reference. It is not a value, account proof, hash, or fingerprint. |
| `accountKey` | Optional metadata for upstream account binding. It must never contain secret material and cannot prove ownership by itself. |

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

Future code must treat identity as a composition of safe metadata, not as a value observation:

- `saveAs` remains the report/profile-source identity used by existing source arrays and diagnostics.
- `(cliId, profileName, envName, accountKey?)` identifies the profile-owned child-environment binding.
- `(backend.kind, backend.handle)` identifies the storage reference, not the account or secret.
- Duplicate `saveAs` values inside one CLI definition must be rejected.
- Duplicate normalized `envName` values inside one CLI/profile binding set must be rejected before runtime. Windows-style case-insensitive comparisons must be tested separately from POSIX-style comparisons.
- Backend handle reuse must be explicit and tested; accidental reuse across profiles or accounts is a hard-stop.

## No schema-only PR rule

A future public parser/schema PR must not land by itself. It must include, in the same PR, one of these reviewed outcomes for every existing `Source` consumer:

1. Correct env-secret behavior for that consumer, or
2. A tested metadata-only hard-stop/refusal result.

A parser that accepts `type: 'env-secret'` while detector, freshness, switch, snapshot, restore, `mat exec`, or `mat session run` still treat it as ordinary missing/stale credentials is unsafe and must be rejected.

## Future runtime consumer matrix

| Consumer | Required future behavior before schema acceptance |
| --- | --- |
| `readSource` / `writeSource` | Must not read or write env-secret values through the existing string serialization path. If unsupported, throw a sanitized typed refusal before value handling. |
| `sourceExists` / detector | Must distinguish an unsupported env-secret source from ordinary missing credentials. A plain boolean `false` is insufficient because it looks recoverable. |
| Freshness | Must report metadata and a stable reason code, not `fresh`, `stale`, value-diff, hash, fingerprint, or live comparison. |
| Doctor/preflight | May report presence/absence, backend kind, env name, profile, CLI, and reason code only. |
| Snapshot/restore/switch | Must hard-stop until at-rest backend custody and explicit profile binding are implemented. |
| Profile export/backup | Must exclude values by default and include only metadata/relink requirements unless a separate encrypted-export design is approved. |
| `mat exec` | May inject only after storage, scrub, masking, audit, and CLI-specific hard-stop tests pass. |
| `mat session run` | Same as `mat exec`, plus existing command-scoped session invariants. |
| `mat session start` | Out of scope; a long-lived shell cannot preserve the env-secret ownership claim. |

### Typed refusal shape

Future code should use a stable typed refusal shape rather than overloading missing/stale states. At minimum it should include:

- a kind/code such as `unsupported-env-secret-source`,
- safe metadata (`saveAs`, `envName`, `cliId`, `profileName` when available, backend kind),
- a sanitized human detail,
- no value, hash, fingerprint, command output, or token-shaped sample.

## Future implementation test requirements

### Unit

- Internal draft validation rejects invalid env names, duplicate `saveAs`, duplicate normalized env names, unsupported backend kinds, prohibited fields, unsafe display characters, and any plaintext fallback knob.
- Future public parser acceptance must keep those checks and pair them with all consumer hard-stops or implemented semantics.
- The existing negative test that rejects env-secret declarations remains until the actual parser PR intentionally updates it.

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

## Verification for closed-parser PRs

- `npm run build:docs`
- `npx vitest run tests/core/env-secret.test.ts tests/core/cli-defs-plugin.test.ts`
- `npm run typecheck`
- `npm test`
- Static scan proving code-level product boundaries remain closed:
  - `src/core/types.ts`
  - `src/core/cli-defs-plugin.ts`
  - `src/core/sources.ts`
  - `src/core/switcher.ts`
  - `src/core/exec.ts`
  - `src/core/session.ts`
  - `src/core/session-cli.ts`
  - `src/cli.tsx`
  - `src/app.tsx`
  - `src/core/cli-defs.ts`
- Static scan proving `type: 'env-secret'` appears only in docs/spec planning or the existing negative test, not in source acceptance.
- Token-shaped addition scan over docs and roadmap changes.

## Stop conditions

Keep public env-secret schema/runtime blocked if any of these are true:

- Parser acceptance would land without runtime semantics or tested hard-stops for all `Source` consumers.
- Storage backend behavior is unspecified, unsupported, untested, or can silently degrade to plaintext.
- Parent-shell environment capture is treated as profile ownership proof.
- A token value, token-shaped placeholder, hash, fingerprint, command output, or raw credential-store output is required as proof.
- `mat exec` or `mat session run` would inject into an arbitrary executable or shell.
- CLI-specific config/MCP/plugin/provider override channels are unresolved for the selected CLI.
- PR text implies this plan implemented public schema or product support.

## Follow-ups

1. Public env-secret parser plus all-consumer hard-stop PR based on this plan.
2. Platform backend spikes/RALPLAN for macOS Keychain, Linux Secret Service, Windows Credential Manager, or an external-provider custody model.
3. Synthetic command-scoped runtime PR only after schema/runtime hard-stops and storage backend selection are approved.
4. Amp config hard-stop matrix, then Amp prototype.
5. Copilot platform/app-state/ambient-token integration, then Copilot prototype.
