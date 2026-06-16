# Copilot macOS/Linux platform proof/probe design — pre-flight admissibility spec (2026-06-16)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, and `mat session run` support.

This document is a **pre-flight evidence admissibility spec** for a future human-opt-in macOS Keychain and Linux Secret Service proof review. It is design-only. It does **not** add an executable probe, does **not** read local credential stores, does **not** collect real evidence, and does **not** add product support.

The purpose is to define what future reviewers may accept or reject before any platform proof can be considered.

## Current public evidence

Sources rechecked for this design:

- GitHub Docs — Authenticating GitHub Copilot CLI: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- GitHub Docs — Copilot CLI command reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- GitHub Docs — Copilot CLI configuration directory: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference>
- GitHub Docs — Troubleshooting GitHub Copilot CLI authentication: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/troubleshoot-copilot-cli-auth>
- GitHub Docs — Copilot CLI programmatic reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference>

Public docs establish useful boundaries:

- Copilot CLI stores OAuth credentials in the OS keychain by default under service name `copilot-cli`.
- macOS uses Keychain Access, Linux uses libsecret / Secret Service, and Windows uses Credential Manager.
- Copilot CLI supports multiple accounts and `/user [show|list|switch]`.
- `~/.copilot/config.json` is automatically managed application state, including account-selection-adjacent state.
- Environment variables such as `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` can override stored credentials.
- If the system credential store is unavailable, Copilot may use plaintext configuration fallback.

Public docs still do **not** prove:

- a stable macOS Keychain account (`acct`) mapping to one Copilot account;
- a stable Linux Secret Service account-like attribute mapping to one Copilot account;
- credential entry cardinality for multi-account setups;
- selector stability across login, switch, refresh, logout, and restart;
- safe scoped delete/write semantics for future `mat` profile operations.

Therefore this document cannot mark platform proof complete.

## Preconditions for any future evidence collection

A future evidence collection may proceed only if all of these are true:

1. A separate PR or review explicitly authorizes collection. This spec alone is not approval to run commands against a real credential store.
2. The user performing collection opts in locally and understands that no raw command output, labels, or values may be committed or pasted.
3. The reviewer defines the exact target platform (`darwin-keychain` or `linux-secret-service`) and account-switch scenario before evidence is collected.
4. The local environment has no competing ambient token variables for the proof context, or the report records that ambient-token policy was not controlled and therefore cannot pass.
5. `~/.copilot/config.json` is treated as app state only; any plaintext credential-looking fallback is handled as credential material and fails this proof path.
6. Evidence is reduced by a human reviewer into the strict redacted report shape validated by `src/core/copilot-credential-proof.ts`.

## Shared proof goals

A future macOS or Linux proof must establish all of these without exposing secrets:

1. **Credential namespace** — the credential-store namespace is tied to `copilot-cli` by upstream docs or human-reviewed metadata.
2. **Per-account selector** — a safe selector field exists beyond service name alone.
3. **One-account binding** — the selector maps to exactly one intended Copilot account binding and is not inferred from display labels alone.
4. **Cardinality** — multi-account setups are one-entry-per-account or another separately reviewed non-ambiguous shape.
5. **Stability** — the selector survives normal login, account switch, token refresh, process restart, and app-state reload scenarios relevant to support.
6. **App-state cross-check** — the selector can be tied to explicit account-state binding from `src/core/copilot-app-state.ts` without relying on last-used state alone.
7. **Ambient-token control** — environment or GitHub CLI fallbacks cannot silently make the observed account differ from the bound profile.
8. **Failure differentiation** — unavailable tooling, denied access, zero entries, ambiguous entries, and proof refusal are distinct outcomes.

## macOS Keychain admissibility design

Expected public namespace: generic-password entries under service `copilot-cli`, unless future upstream docs name a more precise shape.

Service name alone is not proof. A future reviewer may accept only redacted metadata that establishes:

- item kind is compatible with the expected Copilot OAuth credential entry;
- service namespace source is official documentation or human-reviewed metadata;
- a selector field such as `acct` or another reviewed field exists and is safe to reference in a report;
- selector cardinality is non-ambiguous for the account binding under review;
- selector value is stable across the reviewed account lifecycle;
- a future write/delete path could scope operations to the bound entry without service-wide deletion;
- no secret value, raw command transcript, account label, organization, local account identifier, hash, or fingerprint is committed or pasted.

MacOS evidence remains blocked if the only observed fact is service `copilot-cli`, if entries are aggregate/multiple-ambiguous, if the selector is inferred from display text, or if any command mode exposes secret values.

## Linux Secret Service admissibility design

Expected public namespace: libsecret / Secret Service entry under service `copilot-cli`, unless future upstream docs name a more precise shape.

Service name alone is not proof. A future reviewer may accept only redacted metadata that establishes:

- the Secret Service backend and namespace are available and distinguishable from fallback plaintext state;
- the full attribute-name set needed to identify one account is known without exposing attribute values;
- an account-like selector attribute or equivalent reviewed field exists;
- selector cardinality is non-ambiguous for the account binding under review;
- selector value is stable across the reviewed account lifecycle;
- missing `secret-tool`, locked collection, daemon unavailable, denied access, zero entries, and multiple entries are different outcomes;
- no secret value, raw command transcript, account label, organization, local account identifier, hash, or fingerprint is committed or pasted.

Linux evidence remains blocked if it relies on raw secret-bearing command output, if the only known attribute is service `copilot-cli`, or if the backend availability failure is collapsed into “no credential.”

## Redacted report workflow

Future evidence must be reduced into the validator-backed report shape from `docs/superpowers/specs/2026-06-14-copilot-credential-store-proof-contract.md`.

Required workflow:

1. Human reviewer performs any approved local observation outside the repository.
2. Reviewer discards raw local output and records only allowed metadata facts.
3. Reviewer creates a redacted report object with `evidenceKind: "human-reviewed-local-probe"` or an upstream-doc equivalent.
4. Report is checked by `validateCopilotCredentialProofReport`.
5. A passing validator result means **metadata report accepted**, not platform proof.
6. A second reviewer signs off whether the source evidence behind the report is sufficient platform proof.

A platform report may claim `conclusion: "pass"` only when all minimum acceptance criteria in the proof contract are met. Windows reports can be structurally represented with value-free `windowsCredentialBindingProof`, but Windows platform proof remains blocked until human-reviewed source evidence proves Copilot's TargetName/account-guard layout.

## Failure taxonomy

| Outcome | Use when | Product impact |
| --- | --- | --- |
| `blocked` | user did not opt in, tool unavailable, access denied, selector unverified, app-state cross-check not run, ambient policy not controlled | Copilot support remains blocked |
| `fail` | selector missing/ambiguous, aggregate entry, multiple ambiguous entries, app-state mismatch, ambient override unresolved | Copilot support remains blocked |
| `reject evidence` | raw output, secret value, real label, account identifier, hash/fingerprint, or token-shaped text is committed/pasted/observed by this tool | Evidence cannot be used; restart with a safer review path |
| `defer` | requested proof needs executable tooling or hash/fingerprint threat-model approval | Separate security review required |

## Stop conditions

Stop the proof path immediately if any of these occur:

- A command or transcript reveals a credential value.
- Raw Keychain or Secret Service output is pasted into an issue, PR, commit, chat, or fixture.
- Real login labels, email-like labels, organization names, local account identifiers, hashes, or fingerprints appear in committed artifacts.
- The evidence relies on service `copilot-cli` alone.
- The evidence relies on display labels or last-used app state as the account proof.
- Cardinality is aggregate, multiple-ambiguous, or not measured.
- Ambient-token precedence is uncontrolled for a claimed pass.
- The PR text claims product support, platform proof completion, or safe profile swapping.
- The change adds an executable probe, source backend, runtime wiring, or `copilot` builtin without a separate RALPLAN/security review.

## Future gates

This design leaves these gates pending:

1. Decide whether a future proof uses a reviewed manual checklist or an executable local probe.
2. If executable, run a dedicated security review before adding any script.
3. Collect and review macOS evidence without committing raw local output.
4. Collect and review Linux evidence without committing raw local output.
5. Keep Windows product support blocked until Windows source backend and human-reviewed Copilot TargetName/account-guard evidence are proven; metadata-report validation alone is insufficient.
6. Implement ambient-token/env-secret runtime controls before any product flow.
7. Add Copilot product support only after platform proof, app-state write-back policy, Windows/backend gates, and ambient-token/env-secret gates pass.

## Non-goals

- No `copilot` builtin.
- No `SourceType` or plugin schema change.
- No freshness, switcher, session, or command-run support.
- No Keychain, Secret Service, or Windows Credential Manager code.
- No executable local probe script.
- No proof report fixture claiming real platform proof.
- No checked-in local machine output.

## PR acceptance checklist

- This document is the only new spec artifact.
- Existing docs/ROADMAP say only design is complete; actual platform proof remains pending.
- No source/runtime/test files are changed.
- `npm run build:docs` passes.
- `git diff --check` passes.
- Static scans find no product wiring, token-shaped text, or real-label examples in changed docs.
