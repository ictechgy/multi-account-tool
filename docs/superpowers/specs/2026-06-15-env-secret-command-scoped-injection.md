# Env-secret command-scoped injection contract — docs-only design gate (2026-06-15)

## Summary

This document is a **docs-only design contract** for a future `env-secret` source class and command-scoped secret injection. It does not add a `SourceType`, plugin schema, profile storage format, runtime injection, freshness adapter, builtin CLI, or test fixture.

GitHub Copilot CLI (`copilot`) and Amp (`amp`) remain **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, `mat exec`, and `mat session run` product support. This contract only defines the gates a later implementation must satisfy before either CLI can receive a profile-owned environment credential in a child process.

The design goal is narrow: if a CLI's documented non-interactive credential path is an environment variable, `mat` must eventually be able to represent a profile-owned secret by env-var name and inject it into exactly one `mat`-owned command process, while rejecting inherited parent-shell secrets as account-binding evidence.

## RALPLAN consensus result

- Planner decision: choose a docs-only env-secret injection contract before storage/runtime/schema work.
- Architect review: **APPROVE** — Option A is the right unit of change if the spec remains a gate, not a product promise.
- Critic review: **APPROVE** — acceptance criteria and verification are testable; include exact official-doc links/recheck date and cover `mat exec` as well as `mat session run` in future tests.

## Official/public evidence rechecked

Sources rechecked on 2026-06-15:

- GitHub Docs — Authenticating GitHub Copilot CLI: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- GitHub Docs — Copilot CLI programmatic reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference>
- Amp Owner's Manual: <https://ampcode.com/manual>
- Amp SDK documentation: <https://ampcode.com/manual/sdk>

Relevant public contract for this design:

- Copilot CLI documents environment-token authentication with precedence before stored OAuth and GitHub CLI fallback.
- Copilot programmatic docs list the Copilot/GitHub token environment variable names and output-redaction controls, but redaction is not profile ownership proof.
- Amp SDK docs describe a non-interactive access-token environment variable path.
- Amp reads user/workspace settings and supports MCP configuration surfaces that can include command, args, environment, or headers.
- Amp remote MCP OAuth storage is separate tool-server OAuth state and must not be treated as the primary Amp account credential.

Future implementation PRs must recheck these official docs before coding against this contract. The links are current evidence for a safety gate, not a permanent frozen API guarantee.

## Product boundary

This policy gate plus the internal synthetic-core follow-up intentionally still do **not** add any of the following product behavior:

- `SourceType` or `Source` union changes.
- Plugin JSON schema acceptance for env-secret declarations.
- Profile add/import UI, product profile storage, encryption, OS keyring integration, or plaintext profile-file behavior.
- `mat exec` or `mat session run` injection behavior.
- `amp` or `copilot` entries in `BUILTIN_CLI_DEFS`.
- Freshness, recapture, audit, or masking code.
- Real secret values, token-shaped examples, local keychain reads, Secret Service reads, Windows Credential Manager reads, or `gh auth token` invocation.

## Non-normative future source shape

A later implementation may introduce a source kind whose job is to bind one profile-owned secret to one child-process environment variable. The following table is descriptive only; it is not product schema and must not be accepted by the plugin loader until a runtime PR implements validation and storage.

| Concept | Future requirement |
| --- | --- |
| Source kind | A distinct env-secret source kind, not a file/keychain/os-keyring alias. |
| Environment variable name | A validated identifier such as `AMP_API_KEY` or `COPILOT_GITHUB_TOKEN`; the name is metadata, not evidence of ownership. |
| Profile binding | The secret must belong to a specific `mat` profile and, when the upstream CLI has accounts, to an explicit account binding. |
| Storage reference | An opaque handle to the future at-rest storage backend; the spec chooses no backend. |
| Intended target | The builtin CLI/flow allowed to receive the env var. Generic shell export is not enough. |
| Recapture policy | Default is no silent recapture from child environment; any update/rotation flow must be explicit and separately designed. |

### Storage policy gate documented; product implementation remains pending

The storage threat model and UX policy gate is documented in `docs/superpowers/specs/2026-06-15-env-secret-storage-threat-model-ux.md`. That document ranks future backend acceptability and keeps implementation blocked:

1. Platform credential store is the preferred local-custody direction when backed by synthetic tests and explicit consent UX.
2. External provider/no-local-custody is acceptable when a provider-specific design covers consent, lookup failure, rotation, audit, and availability.
3. Encrypted profile-file storage requires a separate key-management design.
4. Plaintext profile-file storage is blocked by default and cannot be a silent fallback.

Unsupported, locked, denied, or untested backends must fail closed before storage or injection. The follow-up internal core now implements synthetic-only primitives and tests, but this injection contract still does not implement product storage or runtime wiring. A later product runtime PR must satisfy the storage/UX gate and must never write, log, hash, diff, fingerprint, or print secret values as evidence.

## Command-scoped injection contract

Future env-secret execution is command-scoped, not shell-scoped.

A supported command run must satisfy all of these rules before spawn:

1. `mat` selects the executable through a builtin allow-list. User arguments after `--` are arguments to that executable, not an arbitrary command or shell.
2. Exactly one child process tree receives the profile-owned env var for the supported flow.
3. Competing inherited parent environment variables for the same credential channel are scrubbed or cause a hard-stop before spawn.
4. The child environment is allowlisted/constructed by `mat`; it is not a pass-through shell environment with one extra secret added.
5. CLI-specific project/user config channels that can override credentials remain separate hard-stop matrices.
6. The run cannot prove account binding by observing a token value, token prefix, token length, hash, transcript redaction, or command output.

### Flow-specific guidance

| Future flow | Contract |
| --- | --- |
| `mat exec <cli> <profile> -- ...` | May inject a profile-owned env-secret into one time-scoped child command only after storage, scrub, masking, audit, and CLI-specific hard-stop tests pass. |
| `mat session run <cli> <profile> -- ...` | May use the same child-process injection contract, plus any existing session materialize/recapture invariants for that builtin. |
| `mat session start <cli>` | Not covered. A long-lived shell lets users add or replace environment variables after launch, so this design cannot claim profile-owned env-secret control there. |
| Normal profile swap/freshness | Not covered. OS-global profile swap cannot make an inherited shell env var profile-owned. |

## Inherited environment policy

Inherited parent-shell variables are not profile-owned secrets.

For future supported flows:

- A variable name matching the CLI's credential channel is a conflict unless it was injected from the selected profile by `mat` for that child process.
- Detection should use names and presence only. It must not inspect or compare values.
- Conflicts should default to hard-stop. Deterministic scrub is acceptable only when the CLI-specific design proves the scrubbed channel cannot fall back to a different account.
- Broad variables such as `GITHUB_TOKEN` must remain flow-specific. Copilot may require special handling because Copilot documents that variable as a Copilot auth source; this does not create a global scrub rule for every `mat` child process.
- Provider credential variables unrelated to the selected CLI account must be handled in the CLI-specific hard-stop matrix, not hidden inside the generic env-secret source.

## Masking, logs, audit, and observability

Future implementation must treat secret values as non-observable material.

Allowed metadata:

- env var name,
- CLI id,
- profile name,
- storage backend kind,
- operation phase,
- pass/fail outcome,
- redacted reason code.

Forbidden evidence:

- actual values,
- token-shaped examples,
- prefixes/suffixes,
- hashes or fingerprints unless a later threat model explicitly approves them,
- before/after diffs of secret material,
- child output that contains the secret,
- `gh auth token` output or equivalent token-printing helper output.

Failure messages should say that a profile-owned env-secret is missing, conflicting, unsupported, or blocked by CLI-specific config; they should not include the secret value or ask the user to paste it into logs.

## Recapture and freshness semantics

Env-secret command runs must be conservative:

- Child processes must not silently rotate, overwrite, or recapture the stored secret through environment mutation.
- A future explicit rotation/update command must be separate from command execution and must define its own non-observation proof.
- Freshness checks may verify metadata and account-binding state, but may not prove freshness by printing, hashing, or comparing token values.
- A successful command run does not prove that the profile secret remains valid for future runs.

## Copilot relationship

The Copilot ambient-token policy remains the controlling flow-specific gate for Copilot. This env-secret design adds the missing generic concept of profile-owned child env injection, but Copilot still requires all of these before support:

- explicit account binding and app-state cross-check,
- platform credential-store selector proof, including Windows Credential Manager backend work for Windows claims,
- ambient-token/fallback controls for Copilot's documented auth precedence,
- no-secret proof that GitHub CLI fallback is disabled or non-interfering for the supported flow,
- CLI-specific hard-stop tests for settings, hooks, skills, MCP, BYOK/offline provider configuration, and other account-affecting channels,
- implementation tests proving no `copilot` builtin support is present until all gates pass.

This document does not add `mat exec copilot`, `mat session run copilot`, or a Copilot profile source.

## Amp relationship

Amp remains blocked for product support. The env-secret design is necessary but insufficient because Amp also needs:

- a storage threat model for the Amp access token source,
- command-scoped injection tests for `mat exec` and `mat session run`,
- hard-stop policy for user settings, workspace `.amp/settings.json{,c}`, `--settings-file`, `--mcp-config`, MCP env/headers, plugins, and workspace overrides,
- a decision on whether local `amp login` state can ever be supported separately from the non-interactive env path,
- tests proving no profile secret values are printed, logged, or copied into project/workspace config.

This document does not add `amp` to builtin CLI definitions and does not claim that Amp can safely run under `mat` today.

## Future implementation test plan

### Unit

- Schema validation rejects empty env names, invalid env names, duplicate `saveAs` or equivalent identity fields, and env-secret declarations before runtime support is enabled.
- Redaction masks secret values in thrown errors, formatted preflight reports, audit events, debug output, and review artifacts.
- Token-shaped fixture strings are rejected in tests and docs examples.

### Integration

- `mat exec <env-secret-cli> <profile> -- ...` injects exactly the profile-owned env var into one child command and scrubs or hard-stops competing inherited env vars.
- `mat session run <env-secret-cli> <profile> -- ...` applies the same injection contract while preserving command-scoped session invariants.
- Missing profile secret, conflicting ambient env, unsupported runtime, malformed storage, and CLI-specific config override all hard-stop before spawn.
- Recapture does not overwrite stored env-secret material from child env mutation unless an explicit update flow is invoked.

### E2E

- A synthetic CLI reports only presence/absence of an env var and exits; logs and artifacts never contain secret material.
- Amp and Copilot prototypes remain blocked until their CLI-specific hard-stop matrices pass.

### Observability

- Audit logs record profile, CLI, env var name, phase, and outcome only.
- No audit/debug channel records values, token-shaped examples, unapproved fingerprints, or child output containing a secret.

## Acceptance checklist for future runtime PRs

- A storage threat model is approved before any values are stored.
- Plugin/schema changes and runtime behavior land together with validation and negative tests.
- Parent env conflicts fail closed unless a flow-specific proof justifies deterministic scrub.
- `mat exec` and `mat session run` both have explicit test coverage if both are supported.
- Copilot/Amp support remains absent until their separate account/config/fallback gates pass.
- Official docs are rechecked in the implementation PR and the relevant policy docs are updated if they changed.

## Stop conditions

Keep env-secret runtime and Copilot/Amp product support blocked if any of these are true:

- The storage backend is unspecified or untested.
- A parent-shell env var can be inherited as if it were profile-owned.
- A token value, token-shaped placeholder, hash, or command output is required as proof.
- The implementation can inject into an arbitrary shell or user-selected executable.
- CLI-specific config/MCP/plugin/provider override channels are unresolved.
- PR text implies that this docs-only contract implemented runtime support.

## Product non-goals

- No public `env-secret` source implementation.
- No `SourceType` or plugin schema changes.
- No profile storage migration.
- No product secret read/write/delete behavior or real backend custody.
- No Copilot or Amp builtin support.
- No `mat exec` or `mat session run` behavior changes.
- No generated examples containing token-like values.

## Follow-ups

1. ✅ Env-secret storage threat model/UX gate documented in `docs/superpowers/specs/2026-06-15-env-secret-storage-threat-model-ux.md`.
2. ✅ Internal env-secret core + synthetic backend tests landed in `src/core/env-secret.ts` and `tests/core/env-secret.test.ts`; no public schema/product runtime/real backend.
3. Public env-secret source/schema RALPLAN before plugin acceptance or profile UX.
4. Amp command-scoped prototype only after env-secret product runtime and Amp config hard-stop matrix.
5. Copilot prototype only after env-secret product runtime plus platform/app-state/ambient-token gates.
