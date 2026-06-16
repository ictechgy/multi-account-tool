# Copilot CLI account-state plan — design-only RALPLAN (2026-06-14)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, and `mat session run` support.

This note is a design artifact only. It does **not** add product support and does **not** add `copilot` to `BUILTIN_CLI_DEFS`.

The next safe Copilot step is explicit account-state design: `mat` must know which Copilot account a profile targets, must not infer that account from last-used state, and must treat Copilot's credential store separately from `~/.copilot/config.json` application state.

## RALPLAN consensus result

- Planner decision: choose explicit account-state design before product code.
- Architect review: **APPROVE** — design is architecturally sound if pseudotypes remain provisional until fixture/parser and platform probes validate them.
- Critic review: **APPROVE** — plan is good enough for a tracked design-spec PR; no required changes.

## Grounded repo constraints

- `SourceType` currently supports only `file`, macOS `keychain`, and Linux `os-keyring` (`src/core/types.ts`). There is no Windows Credential Manager backend yet.
- `KeychainSource.account` and `OsKeyringSource.account` already model account-scoped native keyring entries, but they need a proven upstream account/attribute contract before Copilot can use them safely.
- `mat plugin validate` is a static schema/lint check; it does not read credential stores and must not be treated as security certification.
- The Copilot/Amp research note keeps Copilot blocked until explicit account binding, platform credential-store contracts, a minimal config-state strategy, and ambient token policy gates exist. The ambient-token policy is now documented in `docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md`; runtime/env-secret implementation remains pending.

## Principles

1. **Fail closed on account ambiguity.** Never infer a profile's Copilot account from last-used state alone.
2. **Separate credential store from app state.** OS keychain token entries and `~/.copilot/config.json` account-selection state are different sources with different trust rules.
3. **Minimize mutable state.** Preserve only account-selection fields proven necessary; do not swap plugins, hooks, skills, permissions, or history as credentials.
4. **No secret observation.** Tests and probes must use metadata/fixtures only; no real token values should be read, printed, or compared.
5. **Cross-platform honesty.** Do not claim Windows support until a Windows Credential Manager backend exists.

## Decision

Choose **explicit account-state design first**.

A future Copilot implementation must require an explicit account binding for each profile and must fail closed when that binding cannot be matched to both credential-store metadata and application state.

Do **not** add a simple builtin such as `service=copilot-cli` plus `~/.copilot/config.json`. That would be unsafe because public docs document the keychain service name but do not provide a stable per-account keychain/Secret Service schema, and `config.json` contains application state that should not be blindly swapped.

## Provisional future data contract

These are design-only pseudotypes. They must not be treated as stable product API until redacted fixtures and non-secret platform probes validate them.

```ts
interface CopilotAccountBinding {
  /** User-visible account label shown in CLI/TUI. A login is display text, not proof of store identity. */
  displayLogin: string;

  /** Stable account id if upstream exposes one; optional until proven. */
  stableAccountId?: string;

  /** Platform credential-store account/attribute key after non-secret verification. */
  storeAccountKey?: string;

  /** Platform whose credential-store contract was verified. */
  platform: 'darwin-keychain' | 'linux-secret-service' | 'windows-credential-manager';

  /** How strongly mat can bind this metadata to upstream state. */
  confidence: 'fixture-only' | 'local-probe' | 'upstream-documented';
}

interface CopilotAppStateSnapshot {
  /** Account-selection state only; exact shape must come from fixtures/probes. */
  loggedInUsers?: unknown;

  /** Non-credential metadata explicitly ignored or preserved by policy. */
  ignoredMetadataKeys: string[];

  /** Refuse snapshot when plaintext credential-looking fields are present. */
  containsTokenLikePlaintextFallback: boolean;
}
```

### Identifier rules

- Keep `displayLogin`, `stableAccountId`, and `storeAccountKey` separate.
- A GitHub login may be a useful display label, but must not be assumed to equal a keychain account or Secret Service attribute.
- Empty strings, control characters, and duplicate ambiguous labels must be rejected or require explicit disambiguation.

## `~/.copilot/config.json` policy

`~/.copilot/config.json` must be treated as application state, not as one credential blob.

Required policy before write-back support:

- Parse only account-selection state through an allowlist.
- Treat `loggedInUsers` as a candidate because public docs call it managed application state.
- Treat `installedPlugins`, `firstLaunchAt`, and `staff` as non-credential metadata unless a later fixture/parser PR proves one is required for account selection.
- Any token-like field in plaintext `config.json` is credential material, not app-state; refuse it or route it through a separate credential-source design.
- Unknown account-selection shapes must fail closed.
- Unrelated unknown metadata needs an explicit preserve/ignore policy before any write-back logic is implemented.

## Ambient token policy

Copilot can be affected by ambient fallbacks such as `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, and GitHub CLI token fallback. The flow-specific policy is now documented in `docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md`.

A future implementation must enforce that policy before support:

| Flow | Required behavior before support |
| --- | --- |
| Normal profile swap | Fail closed if ambient tokens could make the active process use a different account than the bound profile. |
| `mat exec` | Either scrub competing env/fallbacks or intentionally inject one profile-owned token into the child through a future env-secret source; document which. |
| Future session flow | Do not claim session isolation until token fallback, credential-store state, and app-state redirect are all scoped to the session. |

The documented policy does not implement env-secret sources and does not unblock Copilot product support.

## Required parser/fixture cases

The next non-design Copilot PR should add redacted fixtures and tests before credential mutation code.

Required cases:

1. Two accounts present and the bound account is selected.
2. Two accounts present while last-used state points to another account.
3. Bound account missing from app state.
4. Unknown account-selection shape.
5. Token-like plaintext fallback detected in `config.json`.
6. Duplicate display labels requiring disambiguation.

Implementation status: fixture parser safety gate complete in `src/core/copilot-app-state.ts` with redacted fixtures under `tests/fixtures/copilot-app-state/` and unit tests in `tests/core/copilot-app-state.test.ts`. This remains non-product validation only: no `copilot` builtin, no credential-store mutation, no freshness adapter, and no session/command-run support were added.

## Product unblock checklist

A future product PR may add Copilot only if all of these are true:

- Add/import requires an explicit account identity and refuses empty/control-character account labels.
- CLI and TUI flows define duplicate-label handling and require confirmation when multiple accounts are present.
- Credential-store matching is tested without secret values:
  - macOS Keychain service+account or documented safe discovery rule.
  - Linux Secret Service attributes or documented safe `secret-tool` contract.
  - Windows Credential Manager target/account only after a new backend exists.
- Config-state parser selects only the bound account and rejects last-used ambiguity.
- Ambient fallbacks are either scrubbed/injected intentionally or cause a hard-stop.
- `mat plugin validate` cannot be used to claim Copilot support.

## Follow-up PR order

1. ✅ **Redacted Copilot app-state fixture/parser PR** — parse account-selection state without secrets; fixture parser safety gate only, not product support.
2. ✅ **macOS/Linux credential-store proof contract/R&D artifact** — defines required non-secret evidence and redaction rules; actual platform proof remains pending (`docs/superpowers/specs/2026-06-14-copilot-credential-store-proof-contract.md`).
3. ✅ **Redacted credential proof-report validator PR** — validate committed report metadata only (`src/core/copilot-credential-proof.ts`); not platform proof and not product support.
4. ✅ **macOS/Linux human-opt-in platform proof/probe design PR** — pre-flight evidence admissibility only (`docs/superpowers/specs/2026-06-16-copilot-platform-proof-probe-design.md`); actual proof remains pending.
5. **macOS/Linux human-reviewed or upstream-doc platform proof PR** — prove account selectors/cardinality without secrets before any prototype.
6. ✅ **Windows Credential Manager source R&D contract** — defines backend/API/CI requirements; runtime implementation remains pending (`docs/superpowers/specs/2026-06-14-windows-credential-manager-source-rd.md`).
7. ✅ **Windows Credential Manager synthetic CI spike** — synthetic CredRead/CredWrite/CredDelete behavior proven in CI; runtime implementation/backend remains pending.
8. ✅ **Ambient token policy PR** — normal swap vs `mat exec` vs future session behavior documented; runtime/env-secret implementation remains pending (`docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md`).
9. **Copilot prototype PR** — only after the previous gates.

## Non-goals

- No `BUILTIN_CLI_DEFS` entry for `copilot`.
- No freshness adapter.
- No `mat session start` or `mat session run` support.
- No real keychain/Secret Service/Windows Credential Manager reads in this design PR.
- No broad `HOME`/XDG redirect experiments as proof of isolation.
