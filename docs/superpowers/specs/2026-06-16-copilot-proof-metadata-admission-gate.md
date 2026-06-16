# Copilot proof metadata admission gate — review-only code gate (2026-06-16)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, `mat exec`, and `mat session run` support.

This PR adds a pure metadata-admission gate for already-redacted Copilot proof reports. It does **not** add an executable probe, does **not** read local credential stores, does **not** collect evidence, and does **not** prove platform behavior.

The gate answers only this question:

> Is this redacted proof report plus a value-free human-review checklist admissible as metadata for later platform-proof review?

A positive answer is `admission: "admissible-metadata"`. It is still **not platform proof** and **not product support**.

## RALPLAN consensus result

Plan artifact: `.omx/plans/copilot-platform-proof-review-gate-ralplan-20260616T101122Z.md`.

- Architect first pass: **ITERATE** — separate gate was sound, but needed metadata-only naming, exact taxonomy, strict checklist, Windows/scope fail-closed behavior, and split verification.
- Critic first pass: **ITERATE** — required full taxonomy priority, product-support claim detection, report `notes` handling, expanded negative tests, and stronger source-purity scans.
- Architect re-review: **APPROVE**.
- Critic final review: **APPROVE**.

## Scope

Implemented module:

- `src/core/copilot-proof-metadata-admission.ts`

Implemented tests:

- `tests/core/copilot-proof-metadata-admission.test.ts`

The module imports only the existing pure proof-report validator and unsafe-evidence scanner. It does not import local filesystem, command execution, OS credential, Keychain, Secret Service, Windows Credential Manager, or runtime child-process helpers.

## Result contract

Every result includes these invariants:

- `proofLevel: "metadata-report-only"`
- `productSupport: "blocked"`

Admission values:

| Admission | Meaning | Product impact |
| --- | --- | --- |
| `admissible-metadata` | The redacted report and checklist satisfy the metadata admission rules. | Copilot remains blocked; human platform proof is still separate. |
| `blocked` | The input is safe to discuss but missing required preconditions, scope alignment, or validator validity. | Copilot remains blocked. |
| `rejected` | The input contains unsafe evidence, raw-output retention, Mat credential-store access, or product-support/proof-complete claims. | Evidence cannot be used. |
| `deferred` | The input requests executable or future collection modes outside this reviewed gate. | Requires separate RALPLAN/security review. |

## Checklist contract

`CopilotProofReviewChecklistV1` is intentionally value-free:

- `schemaVersion: 1`
- exact top-level keys only
- target platform enums only
- boolean review/precondition flags only
- no reviewer names, account labels, local identifiers, evidence snippets, hashes, fingerprints, or freeform evidence strings

Required preconditions include:

- separate authorization recorded
- local user opt-in recorded
- human-reviewed manual collection mode
- raw local output discarded
- Mat did not access a real credential store
- no product-support claim
- no platform-proof-complete claim
- switch scenario reviewed
- app-state cross-check reviewed
- ambient-token policy reviewed
- second reviewer sign-off recorded

The checklist is self-attestation metadata. It does not prove that human review happened; it only prevents a missing or unsafe checklist from becoming admissible metadata.

## Taxonomy priority

The gate applies deterministic priority:

1. Unsafe evidence, raw-output retention, Mat credential-store access, or product-support/proof-complete claim in submitted inputs => `rejected`.
2. Executable or unsupported collection mode => `deferred`, unless a rejected condition is present.
3. Generic proof-report validator failures => `blocked` with validator issue paths/codes only.
4. Missing human-review preconditions or pass-platform scope mismatch => `blocked`.
5. All gates pass => `admissible-metadata`.

Unsafe rejection intentionally outranks softer statuses so dangerous evidence is not hidden by a missing-precondition result.

## Report notes policy

The existing proof-report validator still allows `notes?: string[]` for compatibility with earlier synthetic fixtures.

The metadata-admission gate is stricter: report `notes` must be absent or empty. Non-empty notes block admission, and unsafe notes reject admission without echoing submitted values. This prevents freeform notes from becoming evidence snippets.

## Platform scope policy

The checklist `targetPlatforms` must exactly match every report platform that claims `conclusion: "pass"`.

Windows `metadata-pass` remains only report-shape validation. A Windows pass report is blocked unless explicitly scoped, and even an explicitly scoped metadata admission is not Windows platform proof or product support.

## What this does not do

- No `copilot` builtin.
- No `SourceType` or plugin schema change.
- No freshness, switcher, session, command-run, or profile support.
- No local probe script.
- No credential-store read/write/delete/list code.
- No raw local command output.
- No token values, account labels, hashes, fingerprints, or local identifiers.
- No platform proof completion claim.

## Verification expectations

Required local checks for this slice:

- Targeted tests for the admission gate and existing proof validator.
- Typecheck.
- Docs build.
- Diff whitespace check.
- Source-purity scan of the new module.
- Separate docs/tests scans for secret-shaped or real-label examples.

## Follow-ups

1. ✅ Human evidence review-package manifest gate added in `src/core/copilot-human-evidence-package.ts`; it is metadata packaging only, not platform proof.
2. Human-reviewed macOS evidence package remains pending and requires explicit local opt-in/authorization.
3. Human-reviewed Linux evidence package remains pending and requires explicit local opt-in/authorization.
4. Any executable local probe remains pending and requires separate RALPLAN/security review.
5. Human-reviewed Windows Copilot TargetName/account-guard evidence remains pending.
6. Copilot product support remains blocked until platform proof, app-state write-back policy, Windows evidence/backend gates, ambient-token runtime, and env-secret runtime gates are all resolved.
