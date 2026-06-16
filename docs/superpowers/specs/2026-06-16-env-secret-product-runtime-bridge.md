# Env-secret product runtime bridge — pre-command-surface gate (2026-06-16)

## Summary

This PR adds an **internal env-secret product runtime bridge** that composes public `type: 'env-secret'` source metadata with the reviewed Linux Secret Service backend adapter and command-scoped child-env preparation primitive.

It is deliberately a **pre-command-surface gate**. It does **not** enable:

- `mat exec` env-secret injection.
- `mat session run` env-secret injection.
- `mat session start` env-secret behavior.
- Any CLI-specific builtin support for env-secret credentials.
- Plugin/runtime command injection beyond metadata parsing.
- Plaintext profile-file fallback or real-secret validation evidence.

## RALPLAN consensus result

- Planner decision: choose the public-source runtime bridge only, not direct command-surface support.
- Architect R1: **ITERATE** — strengthen loaded-gun constraints: command-event-only output, no metadata/proof reports, explicit pre-load validation order, all-consumer static boundary checks.
- Critic R1: **APPROVE** — deliberate-mode plan has consistent principles/options, fair alternatives, concrete risk mitigations, and testable acceptance criteria. Non-blocking suggestions were applied: mocked/injected LSS tests only, named `sources`/`switcher` hard-stop tests, and explicit raw `process.env` base-env rejection.

Plan artifact: `.omx/plans/env-secret-product-runtime-ralplan.md`.

## Product boundary

The bridge lives in `src/core/env-secret-product-runtime.ts` and is intentionally not imported by product command surfaces or current `Source` consumers.

The following remain the controlling product behavior after this PR:

| Surface | Status after this PR |
| --- | --- |
| `readSource` / `writeSource` / `sourceExists` | Metadata-only `unsupported-env-secret-source` hard-stop. |
| `switchProfile` / snapshot / restore | Metadata-only hard-stop before live/profile reads or writes. |
| `freshness`, `doctor`, `support`, `detector` | Safe metadata-only blocked/not-checked/unsupported reporting. |
| `mat exec` | Hard-stops before lock/switch/spawn. |
| `mat session start` | Hard-stops in planning. |
| `mat session run` | Hard-stops in preflight/planning before profile reads/spawn. |

## Bridge contract

The bridge accepts already-validated public env-secret source metadata and caller-provided environment maps:

1. Convert every `EnvSecretSource` to an `EnvSecretBinding` for the selected `cliId` and `profileName`.
2. Reject non-env-secret sources, unsupported backends, missing account binding, duplicate normalized env names, raw `process.env` as `baseEnv`, and target-env conflicts in constructed/ambient env maps.
3. Only after those checks pass, instantiate the Linux Secret Service backend or an injected test factory.
4. Compose with `prepareEnvSecretCommandEnv()` to produce a secret-bearing child env and metadata-only command event(s).

The bridge must not call or return backend `metadata()`, `listMetadata()`, or LSS proof reports. Runtime command events omit backend handle and account key; the only secret-bearing return channel is the child env entry selected by the binding env name.

## Tests and evidence policy

Tests use mocked/injected backend factories only. They do not read real Secret Service entries and do not use real credential values.

Coverage added/updated:

- Public LSS source metadata -> binding -> injected backend -> child env composition.
- Multiple env-secret sources.
- POSIX vs Windows duplicate env-name normalization.
- Ambient/base target conflicts before backend factory/load.
- Raw `process.env` base-env rejection.
- Missing/failing backend load sanitization without metadata/proof calls.
- Static boundary scans proving current product consumers and command surfaces do not import the bridge.

## Stop conditions for future command-surface PRs

Keep env-secret command-surface support blocked if any of these are true:

- A proposed command path can load a backend before duplicate/ambient/base hard-stops finish.
- A command path inherits raw `process.env` as the secret-bearing base env.
- Any audit, support, preflight, proof, docs, or test artifact prints secret values or raw backend output.
- A PR combines generic runtime, CLI-specific config/fallback hard-stops, and new builtin support without a fresh RALPLAN.
- Existing `Source` consumers lose their metadata-only hard-stop semantics without a complete replacement implementation.

## Follow-ups

1. RALPLAN a single command surface separately, likely `mat session run` for a CLI whose env-secret and CLI-specific hard-stop matrices are complete.
2. Recheck official CLI docs before any CLI-specific product support PR.
3. Keep Windows Credential Manager source backend and Copilot/Amp reprototype work separate from this bridge.
