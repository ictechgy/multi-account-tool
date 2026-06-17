# Copilot executable probe security review gate (2026-06-17)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat exec`, `mat session start`, and `mat session run` support.

This PR adds a pure security-review gate for **future executable/local probe proposals**. It does **not** add a runnable probe, does **not** run Copilot CLI, does **not** read Keychain, Secret Service, Windows Credential Manager, `~/.copilot`, `gh auth token`, or environment token values, and does **not** collect platform evidence.

The gate answers only this question:

> Is this value-free future-probe proposal complete enough to be eligible for a separate implementation review?

A positive answer is `status: "eligible-for-implementation-review"`. It is still **not execution approval**, **not platform proof**, and **not product support**.

## RALPLAN consensus result

Plan artifact: `.omx/plans/copilot-executable-probe-security-review-ralplan-20260617T124933Z.md`.

- Architect R1: **APPROVE** — pure pre-implementation review gate preserves product and credential boundaries.
- Critic R1: **ITERATE** — required exact exported API, proposal schema, positive synthetic proposal shape, scanner reuse, and executable verification commands.
- Architect R2: **APPROVE** — revised implementation contract resolves R1 without weakening boundaries.
- Critic R2: **APPROVE** — executors can proceed without guessing.

## Scope

Implemented module:

- `src/core/copilot-executable-probe-security-review.ts`

Implemented tests:

- `tests/core/copilot-executable-probe-security-review.test.ts`

The module imports only the existing pure `collectCopilotCredentialProofUnsafeEvidence()` scanner from `src/core/copilot-credential-proof.ts`. It does not import filesystem, process, child-process, credential-store, runtime, source, freshness, session, or CLI-definition modules.

## Result contract

Every result preserves these invariants:

- `productSupport: "blocked"`
- `platformProof: "not-proven"`
- `executableProbe: "not-added"`

Statuses:

| Status | Meaning | Product impact |
| --- | --- | --- |
| `eligible-for-implementation-review` | The proposal is value-free and complete enough for a later implementation PR/review. | Copilot remains blocked; no probe exists. |
| `blocked` | Safe-to-discuss metadata is incomplete or missing required policies/preconditions. | Copilot remains blocked. |
| `rejected` | Unsafe evidence, product/proof claim, runnable probe, Mat credential-store access, broad permission mode, or unknown freeform field is present. | Evidence/proposal cannot be used. |
| `deferred` | The proposal asks for unsupported future collection mode or implementation in the same change. | Separate RALPLAN/security review required. |

Rejected findings outrank deferred and blocked findings so dangerous evidence is never hidden by an ordinary missing-precondition result.

## Proposal contract

The proposal schema is intentionally value-free. It allows only exact keys and enum/boolean metadata for:

- target platform set;
- future collection intent;
- no implementation/runnable probe/Mat credential-store access/product-support claim/platform-proof-complete claim;
- separate authorization, local opt-in, and second-review requirements;
- minimal explicit command permission mode;
- declarative allowed tool classes and denied tool classes;
- ambient-token, isolated config home, plaintext fallback, output redaction, cleanup, failure taxonomy, app-state, switch-scenario, refreshed-docs, and human-redaction policies.

Unknown keys reject the proposal because freeform text could carry raw transcripts, local paths, account labels, or reviewer identifiers.

## Required positive proposal properties

A positive result requires all of these:

- non-empty unique target platforms from `darwin-keychain`, `linux-secret-service`, or `windows-credential-manager`;
- `collectionIntent: "future-executable-local-probe"`;
- `implementationInThisChange: false` and `runnableProbeAdded: false`;
- `credentialStoreAccessedByMat: false`;
- no product-support or platform-proof-complete claim;
- separate authorization, local user opt-in, and second reviewer required;
- `permissionMode: "minimal-explicit-allowlist"`;
- exact allowed tool classes: Copilot metadata, platform credential-store metadata, app-state metadata, ambient-env metadata, and redaction-only;
- exact denied classes: raw credential output, secret value read, shell transcript capture, broad permission mode, product runtime wiring, and source schema wiring;
- ambient token policy must control or block ambient tokens;
- isolated config home required;
- plaintext fallback rejected;
- raw local output discarded before review;
- retained metadata limited to value-free enums;
- hashes, fingerprints, and account labels forbidden;
- no mutation expected, cleanup required, and failure taxonomy required;
- app-state cross-check, switch-scenario review, refreshed docs evidence, and human redaction required.

## What this does not do

- No `copilot` builtin.
- No `SourceType` or plugin schema change.
- No freshness, switcher, `mat exec`, session, command-run, profile, or runtime support.
- No package OS expansion.
- No GitHub Actions workflow change.
- No local probe script or executable entrypoint.
- No Keychain, Secret Service, Windows Credential Manager, `~/.copilot`, `gh auth token`, or environment-token reads.
- No raw local command output, account labels, local identifiers, hashes, fingerprints, token values, or checked-in local evidence.
- No platform proof completion claim.

## Verification expectations

Required checks for this slice:

```sh
npx vitest run tests/core/copilot-executable-probe-security-review.test.ts tests/core/copilot-credential-proof.test.ts tests/core/copilot-proof-metadata-admission.test.ts tests/core/copilot-human-evidence-package.test.ts
npm run typecheck
npm run build:docs
git diff --check
```

Boundary scans:

- changed files must not touch `BUILTIN_CLI_DEFS`, `SourceType`, product parser/schema, source runtime, session/switch/freshness wiring, package OS support, workflow files, or executable script surfaces;
- new module/tests/docs must not contain token-shaped examples, real labels, hashes, fingerprints, raw local output examples, or command transcripts;
- static purity tests must confirm the module has no filesystem/process/child-process/credential-store/runtime imports.

## Follow-ups

1. Any actual local/executable probe remains pending and must use this gate before a separate implementation review.
2. Human-reviewed macOS evidence package remains pending and requires explicit local opt-in/authorization.
3. Human-reviewed Linux evidence package remains pending and requires explicit local opt-in/authorization.
4. Human-reviewed Windows Copilot TargetName/account-guard evidence remains pending.
5. Copilot product support remains blocked until platform proof, app-state write-back policy, Windows evidence/backend gates, ambient-token runtime, and env-secret runtime gates are resolved.
