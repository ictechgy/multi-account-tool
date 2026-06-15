# Env-secret backend custody selection + proof contract — RALPLAN gate (2026-06-15)

## Summary

This document is a **docs-only custody decision and proof contract** for future profile-owned `env-secret` storage. It chooses the first backend spike path and defines the safe evidence, forbidden evidence, failure taxonomy, pass/fail proof matrix, and public parser preconditions that must gate later product work.

It intentionally does **not** add a `SourceType`, plugin parser/schema acceptance, profile UX, product storage backend, runtime environment injection, freshness adapter, built-in CLI support, or Amp/Copilot product support.

## RALPLAN consensus result

- Planner decision: choose a backend custody selection/proof contract before public parser or product runtime work.
- Architect R1 review: **APPROVE** — docs-only progress is justified only because this PR must choose a first backend spike and define concrete proof machinery.
- Critic R1 review: **APPROVE** — the plan preserves closed parser/runtime boundaries and requires metadata-only evidence, product-code no-change scans, and plaintext-file deferral.

## Current product boundary

Current product code remains intentionally closed:

- `SourceType` remains `file`, `keychain`, and `os-keyring` only.
- Plugin definitions that declare `type: 'env-secret'` are still rejected before runtime.
- Existing source operations still map accepted sources to live read, write, and exists behavior; `env-secret` is not routed through those operations.
- Internal synthetic env-secret helpers remain test/planning scaffolding only; they are not product storage and must not be exposed as a backend kind.
- Amp and GitHub Copilot CLI remain blocked for builtin support, freshness, `mat exec`, `mat session start`, and `mat session run`.

## Candidate backend kinds

These are custody candidates for future env-secret work. They are not public schema names until a later parser/runtime PR explicitly implements and tests them.

| Candidate | Decision status | Rationale |
| --- | --- | --- |
| Platform-native credential store | **Chosen family for first spike** | It is the preferred custody model in the storage threat model when synthetic tests, explicit binding, fail-closed unsupported behavior, and metadata-only proof exist. |
| External secret provider | Deferred | Acceptable later with explicit user consent, provider availability semantics, lookup failure behavior, rotation policy, and audit metadata. It should not be hidden behind local-storage naming. |
| Encrypted file | Deferred | Requires a separate key-management, recovery, migration, and encrypted-export RALPLAN. This contract does not approve it. |
| Plaintext file | Rejected by default | Must never be a silent fallback or normal env-secret custody backend. A separate opt-in design with warnings, tests, and reviewer approval would be required before any plaintext fallback exists. |

## First backend spike decision

**Decision:** the next code PR should spike **Linux Secret Service as the first platform-native env-secret custody proof**, aligned with the existing `os-keyring` primitive and current Linux CI support.

Why this path is first:

- The package currently targets Linux and macOS, and CI already includes Ubuntu runners.
- The existing Linux `os-keyring` implementation uses `/usr/bin/secret-tool` and passes secret material through stdin for store operations, avoiding argv exposure for writes.
- The existing source layer already distinguishes Secret Service missing tooling, denied or daemon-down states, ambiguous entries, parse failure, partial cleanup, and rollback failure for the `os-keyring` source family.
- A Linux-first proof can be written as a synthetic metadata-only backend spike without claiming Amp, Copilot, public schema, or cross-platform support.

Deferred alternatives:

- **macOS Keychain** remains a platform-native candidate, but the current CLI path writes values through `security add-generic-password -w`, which has an argv exposure trade-off already documented in the roadmap. A macOS env-secret product backend should wait for an argv-free native path or a separate reviewed exception.
- **Windows Credential Manager** remains blocked until Windows is in package/CI scope and the Windows source backend R&D contract has a synthetic implementation path.
- **External provider** remains a separate no-local-custody design after provider consent, availability, audit, and failure semantics are reviewed.
- **Encrypted or plaintext files** remain outside this path; plaintext is rejected by default.

## Safe proof evidence

The Linux Secret Service spike may collect only metadata and structural outcomes:

- Backend availability status: available, unavailable, denied, locked, or unsupported.
- Operation phase and result code category: create, read-metadata, update, delete, cleanup, or rollback.
- Non-secret source identity metadata: profile name, target CLI id, environment variable name, backend family, backend platform, and opaque handle id.
- Non-secret account binding metadata when explicitly supplied by the test fixture or user consent flow.
- Whether a synthetic entry was created, found, updated, deleted, or refused, without printing the value or raw command output.
- Sanitized failure reason codes and sanitized human detail.
- Cleanup status for synthetic test entries, including whether a tombstone or manual cleanup instruction is required.

Safe proof must be produced through deterministic tests or a redacted report. It must not require a real user account, real upstream credential, real credential label, or command transcript.

## Forbidden evidence

The spike and all review artifacts must not contain:

- Secret values.
- Token-shaped placeholders or samples.
- Prefixes, suffixes, lengths, hashes, fingerprints, checksums, or diffs of secret material.
- Raw output from `secret-tool`, `security`, Windows credential tooling, provider CLIs, or child commands that may include credential material.
- Screenshots, terminal recordings, shell history, debug logs, or CI logs that include credential data or raw credential-store output.
- Parent-shell environment capture as proof of profile ownership.
- Real account labels, real credential labels, real service names from a user's private store, or production provider identifiers.

## Failure taxonomy

Future backend code must classify these states without leaking values or raw output:

| Failure state | Required behavior |
| --- | --- |
| Backend unavailable | Fail closed before storage or injection; report backend family, platform, phase, and reason code only. |
| Backend unsupported | Fail closed and do not fall back to plaintext or parent environment capture. |
| Backend locked | Fail closed; allow a retry path only after explicit user action. |
| Access denied | Fail closed; do not treat as missing. |
| Missing entry | Report missing metadata only; do not infer ownership from parent env. |
| Ambiguous account or handle | Fail closed before read/write/delete. |
| Backend mismatch | Refuse when stored metadata points at a different backend family or platform than the requested profile binding. |
| Stale metadata | Refuse or require relink; do not create a new secret from inherited env automatically. |
| Partial write | Roll back or surface both write and rollback failure categories without values. |
| Partial delete | Keep a hard-stop tombstone or cleanup-required state until backend cleanup is proven. |
| Rollback failure | Report rollback-failed metadata and stop; never continue to injection. |
| Parse or serialization failure | Report a structural reason code only; raw backend output is forbidden. |

## Linux Secret Service proof matrix

The first code spike must prove or explicitly fail each row with synthetic metadata-only evidence.

| Case | Pass condition | Fail condition |
| --- | --- | --- |
| Availability probe | Reports available backend without raw output, or reports unavailable/unsupported with a safe reason code. | Treats unavailable tooling as product support, prints command output, or falls back to plaintext. |
| Synthetic create | Creates a synthetic entry using an argv-free value path and reports only metadata. | Value appears in argv, logs, thrown errors, CI output, or review artifacts. |
| Scoped lookup | Finds exactly the synthetic handle/account binding and reports metadata-only found status. | Service-only lookup can select a sibling entry or ambiguous result. |
| Missing lookup | Reports missing as missing, not denied or fresh. | Missing entry is treated as successful ownership proof. |
| Denied or locked backend | Fails closed with a stable reason code before value handling. | Denied or locked state is treated as missing or silently skipped. |
| Update or replace | Replaces the synthetic entry with rollback or cleanup guarantees and no value output. | Partial write leaves an unsafe state without a hard stop. |
| Delete cleanup | Deletes the synthetic entry or records cleanup-required metadata. | Cleanup failure is hidden or later injection is allowed. |
| Ambiguous entry | Refuses before delete/write when more than one matching entry exists. | Deletes or overwrites all matching entries. |
| Report artifact | Produces a redacted proof report using the template below. | Includes forbidden evidence, raw output, screenshots, or token-shaped samples. |

## Redacted proof report template

A future spike PR should attach a short report with this shape. Values below are placeholders for categories, not examples of secrets.

```text
backend family: platform-native credential store
backend platform: linux-secret-service
product surface: internal spike only
profile: synthetic-profile
cli id: synthetic-cli
env name: SYNTHETIC_ENV
handle id: synthetic-handle
account binding: synthetic-account
operations:
  - phase: availability; outcome: pass-or-refused; reason: safe-reason-code
  - phase: create; outcome: pass-or-refused; reason: safe-reason-code
  - phase: lookup; outcome: pass-or-refused; reason: safe-reason-code
  - phase: update; outcome: pass-or-refused; reason: safe-reason-code
  - phase: delete; outcome: pass-or-refused; reason: safe-reason-code
cleanup: complete-or-required
forbidden evidence reviewed: values, token-shaped samples, hashes, fingerprints, raw output, screenshots, and child command output absent
public parser status: closed
product support status: blocked
```

The report may include test names, file names, backend family, platform, reason codes, and pass/fail categories. It must not include real user labels, real credential labels, raw backend output, or any value-derived observation.

## Implementation status after backend spike

The first internal Linux Secret Service backend spike is now implemented as proof-only code. It adds a strict env-secret backend adapter and strict Secret Service primitives while preserving the existing public os-keyring source fallback semantics.

This does not open public parser/schema acceptance, profile UX, command injection, Amp support, or Copilot support. Public `SourceType` remains unchanged and plugin declarations with `type: 'env-secret'` continue to be rejected before runtime.

## Public parser preconditions

A later public parser/schema PR must not accept `type: 'env-secret'` until all of these are true:

- At least one product backend kind has implementation tests under an approved proof contract.
- The parser exposes only implemented backend kinds and rejects synthetic-only storage.
- Every existing `Source` consumer has either correct env-secret behavior or a tested metadata-only hard-stop/refusal path in the same PR.
- Profile add/import/update/rotate/delete UX exists or the parser explicitly refuses those operations with typed metadata-only reasons.
- `mat exec` and `mat session run` injection remain blocked until storage, scrub, masking, audit, inherited-env conflict handling, and CLI-specific hard-stop tests pass.
- Export and backup exclude values by default; encrypted export remains a separate approved design.
- Doctor, freshness, preflight, logs, audit, docs, PR text, and review artifacts are metadata-only.
- Plaintext fallback remains absent unless a separate explicit opt-in design is approved.
- Amp and Copilot remain blocked until their CLI-specific config, app-state, credential-store, and ambient-token gates pass.

## Stop conditions

Stop the backend spike or parser work if any of these occur:

- The selected Linux Secret Service path cannot prove argv-free writes and metadata-only reports.
- Backend unavailable, denied, locked, ambiguous, partial-delete, or rollback-failed states cannot fail closed.
- Any proof requires values, hashes, fingerprints, token-shaped placeholders, raw backend output, screenshots, or child command output containing material.
- The spike would require mutating real user credentials or relying on real account labels.
- Product docs, PR text, or CLI output imply public env-secret support, Amp support, or Copilot support before parser/runtime gates land.
- Plaintext storage appears as a default or silent fallback.

## Verification for this docs-only PR

- `npm run build:docs`
- `git diff --check`
- `git diff --name-only` shows only docs and roadmap changes.
- `git diff -- src/` is empty.
- Added-line token-shaped scan over docs and roadmap changes has no matches.
- Static scan confirms no new product env-secret wiring in source files.

## Follow-ups

1. ✅ Internal Linux Secret Service backend spike under this proof contract; product parser remains closed.
2. Public parser plus all-consumer typed hard-stop PR only after backend proof and status/refusal APIs are ready.
3. macOS argv-free Keychain backend design or reviewed exception, if macOS env-secret custody is needed.
4. Windows Credential Manager source implementation only after package and CI scope include Windows.
5. External-provider RALPLAN if no-local-custody is chosen for a target CLI.
6. Amp command-scoped prototype only after env-secret product runtime and Amp config hard-stop matrix.
7. Copilot prototype only after env-secret product runtime plus platform/app-state/ambient-token gates.
