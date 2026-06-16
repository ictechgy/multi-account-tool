# Copilot credential-store proof contract — R&D artifact (2026-06-14)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, and `mat session run` support.

This document is a **proof contract / R&D artifact only**. It does not prove the current Copilot macOS Keychain or Linux Secret Service per-account schema, does not add product support, and does not add `copilot` to `BUILTIN_CLI_DEFS`.

The purpose is to define exactly what evidence must exist before `mat` can safely bind a profile to a Copilot credential-store entry on macOS or Linux.

## Official/public evidence rechecked

Sources rechecked during this PR:

- GitHub Docs — Authenticating GitHub Copilot CLI: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- GitHub Docs — Copilot CLI configuration directory: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference>
- GitHub Docs — Copilot CLI command reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>

Publicly documented contract:

- Stored OAuth defaults to OS credential storage under service name `copilot-cli`:
  - macOS Keychain Access
  - Windows Credential Manager
  - Linux libsecret / Secret Service
- If the system credential store is unavailable, Copilot CLI may store a plaintext token fallback in `~/.copilot/config.json`.
- Credential precedence is:
  1. `COPILOT_GITHUB_TOKEN`
  2. `GH_TOKEN`
  3. `GITHUB_TOKEN`
  4. OAuth token from the system credential store
  5. `gh auth token` fallback
- Environment variables can silently override stored OAuth.
- Copilot CLI supports multiple accounts and account switching.
- `~/.copilot/config.json` is automatically managed app state and includes account-selection-adjacent state such as `loggedInUsers`.
- `COPILOT_HOME` can override Copilot configuration/state directory, but public docs do not state that it scopes OS credential-store lookup entries.

What is **not** publicly proven:

- macOS: the stable Keychain account (`acct`) value or safe discovery rule for each Copilot account.
- Linux: the stable Secret Service attributes beyond service name, especially whether an `account` attribute exists and maps one-to-one to a Copilot account.
- Whether Copilot stores one credential entry per account, one aggregate entry, or another layout.
- Whether login/logout/switch/rotation preserve a stable credential-store account key that `mat` can safely capture and restore.

Therefore public `service=copilot-cli` documentation is insufficient for account binding. It identifies a service namespace, not a per-account identity contract.

## Glossary

| Term | Meaning |
| --- | --- |
| Proof contract | This document: the evidence requirements, allowed observations, redaction rules, pass/fail matrix, and stop conditions. |
| Redacted report | A future JSON/Markdown summary that records only non-secret metadata such as entry counts, attribute names, redacted/hashing policy, and conclusions. A report shape is not proof by itself. |
| Local probe | A future human-opt-in procedure that gathers evidence on a local machine. It must be separately reviewed before implementation or execution. |
| Platform proof | Accepted upstream documentation or a human-reviewed opt-in probe result proving the actual platform Copilot credential-store binding schema without exposing tokens. |
| Product support | Adding `copilot` to builtin sources, freshness, profile swap, session, or command-run flows. This document does not do that. |

## Allowed and forbidden observations

### Allowed in committed artifacts

- Official documentation links and quoted/paraphrased public contracts.
- Synthetic examples that use fake service/account names and fake entry counts.
- Redacted report fields that say whether a property was present, absent, ambiguous, or unverified.
- Hashes/fingerprints of local identifiers only if a separate probe review approves the hash threat model.
- Statements that Copilot remains blocked.

### Forbidden in committed artifacts

- Token values, refresh tokens, OAuth secrets, PATs, JWTs, or token-shaped strings.
- Raw macOS `security` command output from a real Copilot entry.
- Raw Secret Service / `secret-tool` output from a real Copilot entry.
- Real GitHub login labels, emails, organization names, or account IDs.
- Unredacted Keychain attributes or Secret Service attributes from a real user machine.
- Claims that a fixture, schema, or redacted report shape proves platform behavior.

### Forbidden probe shortcuts

- Do not use `security ... -w` or `security ... -g` against real Copilot entries; those modes can expose secrets.
- Do not commit or paste `secret-tool search --all service copilot-cli` output. In this codebase, `secret-tool search --all` is treated as secret-bearing because stdout contains the secret value.
- Do not infer account identity from `loggedInUsers`, last-used state, display labels, or `service=copilot-cli` alone.
- Do not treat `COPILOT_HOME` as credential-store isolation unless upstream documents it or a separately reviewed probe proves it.

## Required macOS Keychain proof

A future macOS proof must establish all of the following without exposing token values:

1. **Entry kind and namespace** — Copilot OAuth entries are generic-password entries under service `copilot-cli`, or an upstream doc names the exact equivalent.
2. **Per-account key** — The Keychain account (`acct`) value, or another documented safe selector, maps one-to-one to the Copilot account being bound.
3. **Stable identity** — The selector remains stable across normal `/user switch`, `copilot login`, token refresh, and app restart.
4. **Cardinality** — Multi-account setups produce either exactly one entry per account or another documented shape that can be matched without ambiguity.
5. **Deletion/write safety** — Any future `mat` write path can scope delete/write to the bound entry only; no service-wide destructive operation is required.
6. **No plaintext fallback collision** — If `~/.copilot/config.json` contains a token-like fallback, the app-state parser rejects it as credential material rather than treating it as app-state.
7. **Ambient-token precedence handled** — Env and `gh auth token` fallback cannot silently override the bound credential during supported flows.

Failing any item keeps macOS Copilot support blocked.

## Required Linux Secret Service proof

A future Linux proof must establish all of the following without exposing token values:

1. **Backend namespace** — Copilot stores OAuth in libsecret / Secret Service under service `copilot-cli`, or upstream docs name the exact equivalent.
2. **Attribute schema** — The complete attribute set needed to identify one Copilot account is known. A bare service lookup is insufficient.
3. **Account mapping** — An `account` attribute or equivalent stable attribute maps one-to-one to the Copilot account being bound.
4. **Cardinality and ambiguity** — `service=copilot-cli` with the account selector returns exactly one intended entry; multiple entries or aggregate entries fail closed.
5. **Tooling safety** — The proof procedure does not rely on secret-bearing raw `secret-tool search --all` output being observed by `mat` or committed to the repo.
6. **Backend availability semantics** — Missing `secret-tool`, daemon down, access denied, and zero-entry cases are distinguished. Non-ENOENT infrastructure failures cannot be treated as “no credential.”
7. **No plaintext fallback collision** — Token-like plaintext in `~/.copilot/config.json` remains credential material and is not parsed as app-state.
8. **Ambient-token precedence handled** — Env and `gh auth token` fallback cannot silently override the bound credential during supported flows.

Failing any item keeps Linux Copilot support blocked.

## Redacted report shape for future probes

A future probe or upstream-doc PR may use this shape as a review checklist. The shape is intentionally descriptive. The 2026-06-15 validator added after this contract is a metadata gate only; adding a real platform probe remains a separate follow-up.

```json
{
  "schemaVersion": 1,
  "subject": "github-copilot-cli",
  "evidenceKind": "upstream-documentation | human-reviewed-local-probe",
  "observedAt": "2026-06-14T00:00:00.000Z",
  "platforms": [
    {
      "platform": "darwin-keychain | linux-secret-service | windows-credential-manager",
      "serviceName": "copilot-cli",
      "serviceNameSource": "official-docs",
      "perAccountSelector": {
        "status": "verified | missing | ambiguous | unverified",
        "fieldName": "acct | account | <redacted-field-name>",
        "valuePolicy": "not-committed | synthetic-only | hash-only-after-review"
      },
      "entryCardinality": "one-per-account | aggregate | multiple-ambiguous | missing | unverified",
      "secretValuesObservedByMat": false,
      "rawCredentialStoreOutputCommitted": false,
      "appStateCrossCheck": "matches-redacted-binding | not-run | failed",
      "ambientTokenPolicy": "not-yet-covered | policy-documented-implementation-pending | controlled-by-implementation",
      "windowsCredentialBindingProof": {
        "targetName": {
          "status": "verified | missing | ambiguous | unverified",
          "valuePolicy": "not-committed | synthetic-only"
        },
        "credentialType": "generic",
        "accountUserNameGuard": {
          "status": "verified | missing | ambiguous | unverified",
          "valuePolicy": "not-committed | synthetic-only"
        }
      },
      "conclusion": "pass | fail | blocked"
    }
  ],
  "notes": [
    "Synthetic example only; not platform proof."
  ]
}
```

The validator added in `src/core/copilot-credential-proof.ts` currently accepts only `not-committed` and `synthetic-only` selector/binding value policies. `hash-only-after-review` remains a future RALPLAN/security-review item, not an accepted committed proof policy. The optional `windowsCredentialBindingProof` object is value-free and Windows-only; it records whether a reviewed report established TargetName metadata, `credentialType: "generic"`, and an account/UserName guard. It must never contain actual target names, account labels, hashes, fingerprints, raw credential-store output, or token material. This remains `schemaVersion: 1` because the field is additive and optional unless a Windows platform entry claims `conclusion: "pass"`; older Windows blocked metadata reports remain valid.

## Redacted proof-report validator (2026-06-15)

`src/core/copilot-credential-proof.ts` validates committed, redacted proof-report metadata before any real probe or product flow exists. It is intentionally pure: no filesystem, process, shell, keyring, Secret Service, Keychain, or Windows Credential Manager access.

Validator scope:

- `proofLevel` is always `metadata-report-only`.
- `productSupport` is always `blocked`.
- macOS/Linux `pass` claims must include `serviceName: "copilot-cli"`, a reviewed selector field (`acct`, `account`, or `redactedSelectorField`), value policy `not-committed` or `synthetic-only`, one-entry-per-account cardinality, app-state cross-check, ambient-token policy coverage, and no secret/raw-output flags.
- Windows `pass` claims may now be structurally represented only with value-free `windowsCredentialBindingProof` metadata: TargetName status/policy, `credentialType: "generic"`, and account/UserName guard status/policy. In Windows Credential Manager, lookup identity is `targetName + credentialType`; `account`/UserName is a guard, not a lookup selector and not equivalent to macOS/Linux `perAccountSelector`.
- Windows metadata-pass is still only report-shape validation. It is not human-reviewed platform proof, not a Copilot target/account proof completion claim, and not product support.
- The shared unsafe-evidence scanner rejects token-shaped strings, real-looking non-fixture labels, raw-output fields, secret-like keys, hashes, and fingerprints while reporting key paths only.
- Tests and fixtures live under `tests/core/copilot-credential-proof.test.ts` and `tests/fixtures/copilot-credential-proof/`.

This validator does **not** prove platform behavior, does **not** read local credential stores, and does **not** unblock Copilot product support.

Minimum acceptance for a future real proof:

- `secretValuesObservedByMat` must be `false`.
- `rawCredentialStoreOutputCommitted` must be `false`.
- `perAccountSelector.status` must be `verified` for the target platform; for Windows this is an explicit app/account binding cross-check status, not the Credential Manager lookup selector.
- For Windows, `windowsCredentialBindingProof.targetName.status`, `credentialType`, and `accountUserNameGuard.status` must be verified without committing values.
- `entryCardinality` must be `one-per-account` or another reviewed non-ambiguous shape; for Windows this must describe Copilot's actual Windows credential layout, not merely `CredReadW` exact-target behavior.
- `appStateCrossCheck` must show the credential-store selector can be tied to the explicit app-state binding from `src/core/copilot-app-state.ts`.
- `ambientTokenPolicy` must be at least `policy-documented-implementation-pending` before design review can proceed, and `controlled-by-implementation` before any product flow is unblocked.

## Pass/fail matrix

| Scenario | Result | Reason |
| --- | --- | --- |
| Official docs only name `service=copilot-cli` | Fail / blocked | Service name is not a per-account selector. |
| macOS proof lacks stable `acct` or equivalent selector | Fail / blocked | `KeychainSource.account` cannot be filled safely. |
| Linux proof lacks stable account-like Secret Service attribute | Fail / blocked | `OsKeyringSource.account` cannot be filled safely. |
| `service=copilot-cli` returns multiple entries without a selector | Fail / blocked | Service-wide lookup risks wrong-account swap or destructive clear. |
| Copilot stores one aggregate token entry for all accounts | Fail / redesign | Current account-scoped source model cannot bind one profile to one account. |
| Probe transcript contains token values or raw secret-bearing output | Reject evidence | Secret observation violates this contract. |
| Redacted report validator passes metadata shape only | Not proof | Shape validation is not platform behavior evidence. |
| Windows report includes value-free `windowsCredentialBindingProof` and validates as metadata-pass | Not proof | This is only a metadata-report gate; source evidence still needs human review. |
| Upstream docs or reviewed probe proves per-account selector/binding and cardinality | May proceed to next gate | Still requires app-state write-back policy and ambient-token implementation before product support. |

## Stop conditions

Copilot remains blocked if any of these are true:

- Only service `copilot-cli` is known.
- The per-account selector is absent, ambiguous, or not stable across login/switch/refresh.
- The proof requires observing token values or committing raw credential-store output.
- The app-state binding cannot be cross-checked with the credential-store selector.
- Ambient token precedence is unresolved or only documented but not implemented for the target product flow.
- Windows support is claimed without a Windows Credential Manager backend and tests.
- Windows metadata-pass is described as completed platform proof instead of report-shape validation.
- Any PR text implies product support, completed platform proof, or safe profile swapping before all gates are complete.

## Product non-goals

- No `BUILTIN_CLI_DEFS` entry for `copilot`.
- No freshness adapter.
- No profile swap implementation.
- No `mat session start` or `mat session run` support.
- No credential-store read/write/delete code.
- No local probe script in this PR.
- No real Keychain, Secret Service, or Windows Credential Manager reads in this PR.

## Next follow-ups

1. ✅ Redacted proof-report validator (`src/core/copilot-credential-proof.ts`) — metadata gate only, not platform proof.
2. ✅ Human-opt-in macOS/Linux probe design (`docs/superpowers/specs/2026-06-16-copilot-platform-proof-probe-design.md`) — pre-flight evidence admissibility only; actual platform proof remains pending.
3. ✅ Copilot proof metadata admission gate (`docs/superpowers/specs/2026-06-16-copilot-proof-metadata-admission-gate.md`) — pure review/checklist gate only; actual platform proof remains pending.
4. Human-reviewed macOS/Linux platform evidence collection remains pending and requires separate security/reviewer approval before any executable probe.
5. ✅ Windows Credential Manager source R&D contract (`docs/superpowers/specs/2026-06-14-windows-credential-manager-source-rd.md`) and public `win-credential` primitive; package/builtin Windows support remains blocked.
6. ✅ Windows metadata-report gate in `src/core/copilot-credential-proof.ts` — value-free TargetName/account-guard report shape only, not platform proof.
7. Human-reviewed Windows Copilot TargetName/account-guard evidence remains pending and requires separate security/reviewer approval before any product flow.
8. ✅ Ambient token policy for normal swap, `mat exec`, and future session flows (`docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md`); runtime/env-secret implementation remains pending.
9. Copilot prototype only after app-state, credential-store proof, Windows evidence, ambient-token implementation, and env-secret gates are all resolved.
