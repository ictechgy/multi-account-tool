# Env-secret synthetic command-scoped runtime approval gate — RALPLAN (2026-06-15)

## Summary

This PR adds an **internal synthetic approval gate** for command-scoped env-secret runtime behavior. It proves the generic child-environment contract with a synthetic backend and a controlled child-process probe, but it does **not** enable product env-secret command injection.

Still blocked after this PR:

- `mat exec` env-secret injection.
- `mat session run` env-secret injection.
- `mat session start` env-secret support.
- Plugin runtime injection for public `type: 'env-secret'` definitions.
- Linux Secret Service product runtime injection.
- Amp or Copilot builtin support.
- Profile add/import/update/delete/rotate/export/backup UX for env-secret values.

## RALPLAN consensus result

- Planner decision: choose an internal helper plus synthetic tests, not hidden product command wiring.
- Architect R1/R2: **APPROVE** — the increment is sound if framed as an internal approval gate; the plan must keep `mat exec` / `mat session run` composition deferred.
- Critic R1: **ITERATE** — require repo-wide product-boundary scans, synthetic-only proof, two child-process cases, explicit ambient/base/process isolation, and negative no-spawn assertions.
- Critic R2: **APPROVE** — the revised plan satisfies the proof boundary and testability requirements.

## Current code boundary

The implementation introduces `src/core/env-secret-command-runtime.ts` with `prepareEnvSecretCommandEnv(...)`.

The helper:

1. validates the env-secret binding,
2. requires an explicit caller-constructed `baseEnv`,
3. requires an explicit `ambientEnv` for inherited credential-channel conflict checks,
4. snapshots `baseEnv` and `ambientEnv` before backend load so mutable caller env objects cannot late-add child variables,
5. rejects raw `process.env` as `baseEnv`,
6. hard-stops on ambient or constructed-base target env-name conflicts before backend load,
5. loads a profile-owned value through the supplied `EnvSecretBackend`,
7. builds a child env with the existing metadata-only event shape from `prepareEnvSecretChildEnv`, and
8. returns only `{ env, event }`.

Only `env[binding.envName]` may contain secret material. The event is metadata-only and excludes values, backend handles, account keys, hashes, fingerprints, and child output.

## Product boundary

This helper is intentionally **not** imported by product command surfaces. Tests scan all `src/**/*.{ts,tsx}` and allow `env-secret-command-runtime` / `prepareEnvSecretCommandEnv` only in `src/core/env-secret-command-runtime.ts`.

The proof is synthetic-only:

- no `createLssEnvBackend` import or instantiation,
- no `env-secret-linux-secret-service` import,
- no raw Secret Service / keychain / platform credential-store output,
- no Amp/Copilot builtin or parser runtime wiring.

## Runtime proof contract

The tests prove:

- prepared env -> controlled child exact stdout `present`, empty stderr, exit 0,
- constructed base/control env -> controlled child exact stdout `missing`, empty stderr, exit 0,
- child process uses `shell: false` with piped stdio,
- stdout/stderr never contain the synthetic value,
- helper does not read or copy `process.env` and rejects raw `process.env` as `baseEnv`,
- unrelated ambient-only variables and late-added mutable `baseEnv` variables are not copied into returned child env,
- `process.env`, `baseEnv`, and `ambientEnv` remain unchanged,
- target ambient conflicts hard-stop before backend `load`, and
- missing secret, backend failure, backend mismatch, and ambient conflict reject before any child spawn helper is called.

## Acceptance criteria

- The helper requires explicit `baseEnv` and `ambientEnv`, snapshots them before async backend load, and rejects raw `process.env` as `baseEnv`.
- Ambient and base target env-name conflicts fail closed before backend load.
- Success returns one secret-bearing env entry and a metadata-only event.
- Negative paths do not return a child env and do not spawn a child.
- Existing public env-secret `mat exec` and `mat session run` hard-stops remain green.
- Product source files outside the helper do not reference the helper/module.
- Linux Secret Service runtime injection, Amp, Copilot, and plugin runtime injection remain blocked.

## Verification

Recommended PR validation:

```bash
npm run typecheck
npx vitest run tests/core/env-secret.test.ts tests/core/env-secret-command-runtime.test.ts tests/core/session.test.ts tests/core/exec.test.ts tests/core/cli-defs-plugin.test.ts
npm test
npm run build:docs
git diff --check
```

Also run static scans for token-shaped added lines and product wiring mentions of `prepareEnvSecretCommandEnv`, `env-secret-command-runtime`, `createLssEnvBackend`, `env-secret-linux-secret-service`, `amp`, and `copilot`.

## ADR

- **Decision:** Add an internal synthetic command-runtime helper and proof tests only.
- **Drivers:** Preserve PR #119 metadata-only hard-stops, prove generic child-env runtime invariants, and reduce future Amp/Copilot review risk.
- **Alternatives considered:** Hidden synthetic `mat exec` / `session run` path (too likely to imply product support); Amp matrix first (valid but leaves generic runtime proof gap).
- **Why chosen:** This is the smallest reviewable increment that advances the roadmap without opening user-facing runtime support.
- **Consequences:** Future product wiring still needs a new RALPLAN after CLI-specific config/fallback matrices pass.
- **Follow-ups:** Amp config hard-stop matrix; Copilot account-selector/platform proof; env-secret product runtime bridge; eventual product command injection PR if all generic and CLI-specific gates pass.
