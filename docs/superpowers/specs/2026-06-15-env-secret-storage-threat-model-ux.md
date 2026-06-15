# Env-secret storage threat model + UX contract — docs-only design gate (2026-06-15)

## Summary

This document is a **docs-only design gate** for future profile-owned env-secret storage. It defines the storage threat model, user consent UX, backend policy ranking, no-secret evidence rules, and future test obligations that must exist before any env-secret value is stored or injected by `mat`.

This document itself is a policy gate. The follow-up internal implementation now adds synthetic-only env-secret primitives in `src/core/env-secret.ts`, but it still does not enable Amp (`amp`) or GitHub Copilot CLI (`copilot`) product support, public schema, real storage backends, or user-facing runtime behavior.

## RALPLAN consensus result

- Planner decision: choose a docs-only storage threat model + UX contract before runtime/schema/storage work.
- Architect R2 review: **APPROVE** — the plan is architecturally sufficient if the spec stays a gate and preserves fail-closed/non-observation boundaries.
- Critic R1 review: **APPROVE** — acceptance criteria and verification are concrete; keep export/backup semantics explicit and avoid roadmap wording that implies implemented storage.

## Product boundary

This policy gate plus the internal synthetic-core follow-up intentionally still do **not** add any of the following product behavior:

- New `SourceType` or `Source` union entries.
- Plugin JSON schema acceptance for environment-secret declarations.
- Profile add/import UI or TUI flows.
- Product runtime storage, read, write, update, rotate, or delete behavior.
- Product environment injection behavior for `mat exec` or `mat session run`.
- Profile migration, backup/export implementation, encryption code, or OS credential-store integration.
- Freshness, recapture, doctor, audit, or masking code.
- `amp` or `copilot` entries in `BUILTIN_CLI_DEFS`.
- Real secret values, token-shaped examples, local Keychain reads, Secret Service reads, Windows Credential Manager reads, or token-printing helper invocation.

## Relationship to the command-scoped injection contract

The env-secret command-scoped injection contract defines how a future child process may receive a profile-owned environment credential after storage exists. That contract intentionally deferred the at-rest decision.

This document resolves the storage/UX policy gate. The first implementation follow-up is intentionally internal and synthetic-only; future product env-secret work still needs separate schema, UX, real-backend, and command-runtime PRs with reviewer approval before users can configure or run profile-owned environment credentials.

The public source/schema exposure RALPLAN defines the future schema candidate and consumer hard-stop matrix, but it does not open plugin/parser acceptance.

The backend custody selection/proof contract chooses Linux Secret Service as the first platform-native backend spike under metadata-only proof rules; it still does not implement product storage or parser acceptance.

## Threat model

### Assets

- The secret value bound to a profile and environment variable name.
- The profile binding that says which `mat` profile owns the secret.
- The intended target CLI and, when applicable, the upstream account binding.
- The storage backend handle or opaque reference.
- Allowed audit metadata: operation type, profile, target CLI, environment variable name, backend kind, and pass/fail outcome.

### Non-evidence

The following must not be treated as proof that a secret belongs to a profile:

- A parent-shell environment variable with a matching name.
- A successful child command run.
- A token value, prefix, suffix, length, hash, or fingerprint.
- CLI transcript redaction.
- A service name without a stable account selector.
- Output from any command that can reveal credential material.

### Failure modes and attackers

- Accidental leakage through shell history, debug logs, CI logs, PR comments, review artifacts, or generated docs.
- Silent capture of an inherited parent-shell variable that belongs to another account, CI job, or tool.
- Wrong-profile import or restore when metadata is copied without an explicit profile/account binding.
- Platform degradation where one OS stores securely and another silently falls back to plaintext or unsupported behavior.
- Backup/export flows that unintentionally include secret values.
- Doctor, freshness, or preflight output that reveals more than metadata.
- Delete/rotation drift where old backend entries remain usable after the profile appears updated.

This design does not claim protection against a compromised operating system, compromised credential-store backend, malicious user with full account access, or upstream CLI behavior that changes without documentation. Those cases remain future implementation risk inputs.

### Trust boundaries

| Boundary | Policy |
| --- | --- |
| Profile metadata | May store identifiers and backend references, not secret values. |
| Platform credential store | Candidate place for future value custody, but only after synthetic backend tests. |
| External secret provider | Acceptable future custody model if the provider integration has explicit consent and availability semantics. |
| Child process environment | Receives a value only in a future command-scoped flow after storage and scrub tests pass. |
| Logs, audits, docs, review artifacts | Metadata only; no values, hashes, token-shaped placeholders, or command output that can contain values. |

## Backend policy ranking

Future implementation should rank storage options as follows:

1. **Platform credential store** — preferred default when a platform backend has synthetic tests, explicit profile/account binding, and fail-closed unsupported behavior.
2. **External secret provider / no local value custody** — acceptable if users explicitly approve provider use and the design covers availability, lookup failure, and audit metadata.
3. **Encrypted profile file** — not approved by this document; requires a separate key-management RALPLAN, UX, migration, recovery, and export design.
4. **Plaintext profile file** — blocked by default. It must never be a silent fallback. A separate PR would need explicit opt-in UX, warnings, tests, and reviewer approval before any plaintext fallback can exist.

Unsupported, locked, denied, or untested backends must fail closed before storage or injection. A future implementation must not downgrade from a platform store to plaintext or to parent-shell capture because a backend is unavailable.

## Platform/backend matrix

| Backend candidate | Status after this PR | Required before implementation |
| --- | --- | --- |
| macOS Keychain | Deferred platform-native candidate | Synthetic add/read/update/delete tests, explicit service/account or opaque-handle contract, denied-access failure behavior, no value output, and an argv-free write path or reviewed exception. |
| Linux Secret Service | First backend spike selected | Synthetic entries, locked/unavailable service failure behavior, no raw secret-bearing command output in artifacts, stable attribute contract, and metadata-only proof report. |
| Windows Credential Manager | Pending backend | Windows source backend and synthetic CI remain required before any Windows env-secret storage claim. |
| External provider | Future design only | Provider-specific RALPLAN covering consent, lookup failure, rotation, audit, and no local value custody. |
| Encrypted profile file | Future design only | Key-management design, recovery and migration policy, encrypted export policy, and negative tests. |
| Plaintext profile file | Blocked default | Separate opt-in PR with warnings and tests; no silent fallback. |

## UX contract

### Add/import

- The user must explicitly choose to create or import a profile-owned environment secret.
- The UX must display the target profile, target CLI, environment variable name, storage backend kind, and whether the secret will be locally stored or externally referenced.
- The UX must not silently capture a parent-shell variable by name alone. If a future import path reads from the current environment, it must require an explicit confirmation that custody is being transferred to the selected profile.
- The UI and logs may record metadata only.

### Update/rotate

- Rotation must be a separate explicit flow, not a side effect of command execution.
- The flow must confirm the profile, environment variable name, backend kind, and target CLI before replacing the stored value.
- A child process must not update or recapture env-secret material through environment mutation.

### Delete/revoke

- Delete must remove the profile metadata and the backend entry or mark a hard-stop tombstone when cleanup cannot be proven.
- Partial delete failures must fail closed and tell the user which metadata/backend step failed without exposing values.
- Delete must be idempotent: repeating it must not reveal whether a prior value existed beyond safe metadata/status.

### Export/backup

- Default profile export and backup must exclude secret values.
- Export may include non-secret metadata such as profile, target CLI, environment variable name, backend kind, and a missing-secret/relink requirement.
- Any encrypted export containing secret values requires a separate approved design with key management, recovery, and redaction tests.

### Doctor/freshness/preflight

- These flows may report presence/absence, backend kind, profile binding, target CLI, age or staleness metadata, and failure reason codes.
- They must not print, hash, compare, diff, or fingerprint values.
- Freshness cannot be proven solely by running a child command successfully.

## Allowed metadata vs forbidden observations

| Allowed metadata | Forbidden observations |
| --- | --- |
| Profile name/id | Secret value |
| Target CLI id | Token-shaped placeholder or sample |
| Environment variable name | Prefix, suffix, length, hash, or fingerprint of a value |
| Backend kind and opaque handle id | Before/after diff of secret material |
| Operation type and phase | Child output containing secret material |
| Pass/fail outcome and redacted reason code | Credential-store raw output that may include values |
| Synthetic fixture labels in tests | Real account labels, real credential labels, or user secrets in artifacts |

## Future implementation test plan

### Unit

- Schema validation rejects missing profile binding, invalid environment variable names, duplicate identifiers, unsupported backends, and plaintext fallback without explicit opt-in.
- Redaction covers errors, audit events, doctor output, freshness output, preflight reports, and review artifacts.
- Export/backup defaults exclude secret values.
- Unsupported platform/backend states fail closed.

### Integration

- Add/import/update/delete flows use synthetic values and never print them.
- Backend unavailable, locked, denied, ambiguous, and partial-delete states fail closed before storage or injection.
- Rotation does not occur through command execution or recapture.
- Export includes metadata only unless a separately approved encrypted export flow exists.

### E2E

- A synthetic CLI receives only presence of a future stored env-secret through an approved command-scoped flow after storage setup.
- Parent-shell conflicts hard-stop or are scrubbed only under a CLI-specific proof.
- Logs and artifacts contain metadata only.

### Observability

- Audit records operation type, profile, target CLI, environment variable name, backend kind, phase, and outcome only.
- Debug and failure output never records values, token-shaped placeholders, hashes, fingerprints, or child output containing secret material.

## Acceptance checklist for future runtime/storage PRs

- Storage backend is selected and tested before any value is handled.
- User consent UX covers add/import/update/rotate/delete/export/backup.
- Platform/backend support matrix fails closed for unsupported or untested states.
- Plaintext profile-file fallback remains absent unless a separate explicit opt-in PR approves it.
- Export/backup excludes secret values by default.
- Command-scoped injection remains blocked until storage, scrub, masking, audit, CLI-specific hard-stop, and synthetic E2E tests pass.
- Amp and Copilot remain blocked until their separate account/config/fallback/platform gates pass.

## Stop conditions

Keep env-secret runtime and Amp/Copilot product support blocked if any of these are true:

- Storage backend behavior is unspecified, unsupported, or untested.
- A parent-shell environment variable can be captured or inherited as profile-owned evidence.
- Secret values, token-shaped examples, hashes, fingerprints, or command output are required as proof.
- Plaintext storage is used as a default or silent fallback.
- Delete/rotation/export semantics are unresolved.
- PR text implies this policy gate alone implemented product runtime storage or command injection.

## Follow-ups

1. ✅ Internal env-secret runtime/schema/storage primitives with synthetic backend tests (`src/core/env-secret.ts`, `tests/core/env-secret.test.ts`); no product exposure.
2. ✅ Public env-secret source/schema exposure RALPLAN documented in `docs/superpowers/specs/2026-06-15-env-secret-public-source-schema-plan.md`; parser/schema/product runtime remain closed.
3. ✅ Backend custody selection/proof contract documented; Linux Secret Service is the first backend spike, product parser remains closed.
4. Linux Secret Service backend spike under the custody proof contract.
5. Public env-secret schema/runtime hard-stop implementation PR before plugin acceptance or profile UX.
6. External-provider RALPLAN if no-local-custody is chosen for a CLI.
7. Amp command-scoped prototype only after env-secret product runtime and Amp config hard-stop matrix.
8. Copilot prototype only after env-secret product runtime plus platform/app-state/ambient-token gates.
