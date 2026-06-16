# Copilot human evidence package — review-package gate (2026-06-16)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat exec`, `mat session start`, and `mat session run` support.

This PR adds a pure human evidence package layer for already-redacted Copilot proof metadata. It is a **review-package gate only**. It does **not** add platform proof, does **not** add an executable probe, does **not** read credential stores, and does **not** add product support.

The package layer answers only this question:

> Does this redacted report and value-free checklist match the declared review-package manifest?

A positive answer is `status: "admissible-metadata-package"`. That status still means only metadata is package-admissible for later human review. It is not platform proof and not Copilot support.

## RALPLAN consensus result

Plan artifact: `.omx/plans/copilot-human-evidence-package-ralplan-20260616T133515Z.md`.

- Architect first pass: **APPROVE** with implementation clarifications for exact scope rules and product-boundary scans.
- Critic first pass: **ITERATE** until package-manifest rules, manifest/checklist/pass-platform equality, thin delegation, changed-file whitelist, and false-support wording became testable.
- Architect re-review: **APPROVE**.
- Critic final review: **APPROVE**.

## Scope

Implemented module:

- `src/core/copilot-human-evidence-package.ts`

Implemented tests:

- `tests/core/copilot-human-evidence-package.test.ts`

The module delegates report and checklist evaluation to `evaluateCopilotProofMetadataAdmission`. It does not reimplement unsafe-evidence scanning, product-claim scanning, proof-report validation, or credential-store logic.

## Review-package scopes

The package scopes are review scopes only, not platform support scopes.

| Scope | Allowed manifest targets | Notes |
| --- | --- | --- |
| `macos-linux-platform-evidence` | non-empty subset of `darwin-keychain`, `linux-secret-service` | macOS/Linux metadata package review only. |
| `windows-target-account-guard-review` | exactly `windows-credential-manager` | Windows TargetName/account-guard metadata package review only. |

The package layer blocks empty targets, duplicates, mixed targets, and cross-scope targets.

## Match requirements

For an OK package result, all of these must match the package manifest target set exactly:

- submitted checklist `targetPlatforms`;
- delegated admission `targetPlatforms`;
- delegated admission `passPlatforms`.

A blank package template intentionally evaluates as blocked because it has no pass platform. Templates are for humans to fill after an approved external review process; they are not evidence by themselves.

## Result contract

Every package evaluation preserves these invariants:

- `proofLevel: "metadata-report-only"`
- `productSupport: "blocked"`

Package statuses:

| Status | Meaning | Product impact |
| --- | --- | --- |
| `admissible-metadata-package` | Manifest, redacted report, and checklist line up as metadata. | Copilot remains blocked. |
| `blocked` | Safe-to-discuss metadata is incomplete, mismatched, or not pass-shaped for the manifest. | Copilot remains blocked. |
| `rejected` | Delegated admission found unsafe evidence or forbidden claims. | Evidence cannot be used. |
| `deferred` | Delegated admission requires executable/future collection review. | Separate RALPLAN/security review required. |

## What this does not do

- No `copilot` builtin.
- No `SourceType` or plugin schema change.
- No freshness, switcher, `mat exec`, session, or command-run support.
- No package OS expansion.
- No local probe script or executable collection helper.
- No Keychain, Secret Service, Windows Credential Manager, `~/.copilot/config.json`, `gh auth token`, or environment-token reads.
- No raw local output, token values, account labels, hashes, fingerprints, or local identifiers.
- No platform proof completion claim.

## Verification expectations

Required checks for this slice:

- Targeted tests for the new package layer and existing proof/admission gates.
- Typecheck.
- Docs build.
- Diff whitespace check.
- Changed-file whitelist: new package module, new tests, Copilot proof docs, and `ROADMAP.md` only.
- Source-purity scan for no filesystem/process/shell/credential-store imports in the new module.
- Product-boundary scan for no `BUILTIN_CLI_DEFS`, `SourceType`, parser/schema, runtime/session/switch/freshness wiring, executable probe entrypoints, or package OS expansion in changed files.
- Secret/raw-output scan for token-shaped examples, real-label examples, and raw local output examples in changed docs/tests.

## Follow-ups

1. Human-reviewed macOS evidence package remains pending and requires explicit local opt-in/authorization.
2. Human-reviewed Linux evidence package remains pending and requires explicit local opt-in/authorization.
3. Human-reviewed Windows Copilot TargetName/account-guard evidence remains pending.
4. Any executable local probe remains pending and requires separate RALPLAN/security review.
5. Copilot product support remains blocked until platform proof, app-state write-back policy, Windows evidence/backend gates, ambient-token runtime, and env-secret runtime gates are all resolved.
