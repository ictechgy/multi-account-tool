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
| Platform proof | Accepted upstream documentation or a human-reviewed opt-in probe result proving the actual macOS/Linux Copilot credential-store account schema without exposing tokens. |
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

A future probe or upstream-doc PR may use this shape as a review checklist. The shape is intentionally descriptive; adding a validator or probe is a separate follow-up.

```json
{
  "schemaVersion": 1,
  "subject": "github-copilot-cli",
  "evidenceKind": "upstream-documentation | human-reviewed-local-probe",
  "observedAt": "2026-06-14T00:00:00.000Z",
  "platforms": [
    {
      "platform": "darwin-keychain | linux-secret-service",
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
      "ambientTokenPolicy": "not-yet-covered | controlled-by-separate-policy",
      "conclusion": "pass | fail | blocked"
    }
  ],
  "notes": [
    "Synthetic example only; not platform proof."
  ]
}
```

Minimum acceptance for a future real proof:

- `secretValuesObservedByMat` must be `false`.
- `rawCredentialStoreOutputCommitted` must be `false`.
- `perAccountSelector.status` must be `verified` for the target platform.
- `entryCardinality` must be `one-per-account` or another reviewed non-ambiguous shape.
- `appStateCrossCheck` must show the credential-store selector can be tied to the explicit app-state binding from `src/core/copilot-app-state.ts`.
- `ambientTokenPolicy` must be covered before any product flow is unblocked.

## Pass/fail matrix

| Scenario | Result | Reason |
| --- | --- | --- |
| Official docs only name `service=copilot-cli` | Fail / blocked | Service name is not a per-account selector. |
| macOS proof lacks stable `acct` or equivalent selector | Fail / blocked | `KeychainSource.account` cannot be filled safely. |
| Linux proof lacks stable account-like Secret Service attribute | Fail / blocked | `OsKeyringSource.account` cannot be filled safely. |
| `service=copilot-cli` returns multiple entries without a selector | Fail / blocked | Service-wide lookup risks wrong-account swap or destructive clear. |
| Copilot stores one aggregate token entry for all accounts | Fail / redesign | Current account-scoped source model cannot bind one profile to one account. |
| Probe transcript contains token values or raw secret-bearing output | Reject evidence | Secret observation violates this contract. |
| Redacted report shape passes fixture lint only | Not proof | Shape validation is not platform behavior evidence. |
| Upstream docs or reviewed probe proves per-account selector and cardinality | May proceed to next gate | Still requires Windows decision, app-state write-back policy, and ambient-token policy before product support. |

## Stop conditions

Copilot remains blocked if any of these are true:

- Only service `copilot-cli` is known.
- The per-account selector is absent, ambiguous, or not stable across login/switch/refresh.
- The proof requires observing token values or committing raw credential-store output.
- The app-state binding cannot be cross-checked with the credential-store selector.
- Ambient token precedence is unresolved for the target flow.
- Windows support is claimed without a Windows Credential Manager backend and tests.
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

1. Optional redacted probe-report validator after this contract is reviewed.
2. Human-opt-in macOS/Linux probe design with a separate security review.
3. Windows Credential Manager source R&D.
4. Ambient token policy for normal swap, `mat exec`, and future session flows.
5. Copilot prototype only after app-state, credential-store, Windows, and ambient-token gates are all resolved.
