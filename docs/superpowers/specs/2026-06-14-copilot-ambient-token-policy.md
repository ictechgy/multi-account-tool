# Copilot ambient-token policy — docs-only gate (2026-06-14)

## Summary

GitHub Copilot CLI (`copilot`) remains **blocked** for builtin `mat` profile-swap, freshness, `mat session start`, and `mat session run` support.

This document is a **docs-only policy gate**. It does not add product support, does not add `copilot` to `BUILTIN_CLI_DEFS`, does not implement env-secret sources, and does not read, write, delete, print, or compare any credential value.

The policy closes one remaining design gap: Copilot CLI can authenticate through ambient GitHub tokens and GitHub CLI fallback before or instead of a stored OAuth credential. A future `mat` Copilot profile cannot be account-safe unless these ambient channels are either explicitly owned by the profile, scrubbed from the child process, disabled, or proven non-interfering for the target flow.

## RALPLAN consensus result

- Planner decision: choose a docs-only ambient-token policy before product code.
- Architect review: **APPROVE** — policy is architecturally sound if it stays flow-specific and does not imply product support.
- Critic review: **APPROVE** — acceptance criteria and verification are testable after fixing the source-creep check and adding explicit `GITHUB_TOKEN` / BYOK coverage.

## Official/public evidence rechecked

Sources rechecked on 2026-06-15:

- GitHub Docs — Authenticating GitHub Copilot CLI: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli>
- GitHub Docs — Copilot CLI programmatic reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-programmatic-reference>
- GitHub Docs — Copilot CLI command reference: <https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-command-reference>
- GitHub Docs — Installing GitHub Copilot CLI: <https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli>

Publicly documented contract relevant to this policy:

- Copilot CLI can authenticate with environment variables intended for non-interactive environments.
- The documented environment-token precedence is `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`.
- Stored OAuth credentials from the system keychain are checked after those environment variables.
- GitHub CLI (`gh auth token`) fallback is checked after stored OAuth credentials.
- GitHub Docs explicitly warn that an environment variable can silently override a stored OAuth token.
- Programmatic Copilot CLI docs list `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` as authentication environment variables.
- Copilot CLI has transcript/output redaction controls, but redaction is not a profile-binding proof and does not make token observation acceptable for `mat`.
- Copilot CLI BYOK/offline modes can alter whether GitHub authentication is needed for a given Copilot use, but they do not prove which GitHub account a `mat` profile is bound to.

Future implementation PRs must recheck these official docs before coding against this policy. The docs are evidence for a safety gate, not a permanent frozen API guarantee.

## Why ambient tokens are not account-binding proof

An ambient token proves only that a token-like credential is available to the process. It does **not** prove:

- which `mat` profile owns the token,
- which GitHub account the token represents,
- whether that account matches Copilot app-state account selection,
- whether the token came from a user's shell, CI, GitHub Actions, another tool, or a future `mat` env-secret source,
- whether `gh auth token` fallback would select a different account after env vars are scrubbed.

Therefore `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, and `gh auth token` must be treated as account-selection override channels, not as safe background details.

## Policy matrix

| Flow | Required policy before Copilot support | Rationale |
| --- | --- | --- |
| Normal profile swap / freshness | Hard-stop if `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` is present and not explicitly owned by a future profile-bound env-secret source. `gh` fallback must be disabled or proven non-interfering without reading token output. | Normal swap is OS/user-environment global; an inherited token can silently override the stored OAuth credential and create wrong-account behavior. |
| `mat exec copilot <profile> -- ...` | Future support may inject exactly one profile-owned Copilot token, preferably via `COPILOT_GITHUB_TOKEN`, only through a reviewed env-secret source. The child environment must scrub unrelated `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN`; `gh` fallback must not select an unbound account. | `mat exec` is time-scoped to one child process, so explicit injection can be safe later, but inherited ambient auth is still unsafe. |
| Future `mat session run copilot ...` | Same as `mat exec`, but command-scoped boundaries must also cover session materialization/recapture, app-state, and credential-store selector consistency. | A command-scoped session can be safe only if all credential and app-state channels are scoped to the profile. |
| Future interactive `mat session start` support | Do not claim Copilot support unless credential-store state, app-state, and ambient auth channels are all scoped to the session. If a shell remains open, user-set tokens inside that shell are outside `mat`'s profile guarantee and must be documented. | Long-lived shells let users mutate env after launch; profile claims must not overstate control. |
| CI/headless / automation | Prefer future explicit env-secret source injection over OS credential-store mutation. Do not use host `GH_TOKEN` or `GITHUB_TOKEN` implicitly; they may be GitHub Actions or GitHub CLI credentials unrelated to the selected profile. | Non-interactive environments commonly set GitHub tokens for other tasks. |
| BYOK/offline provider env | BYOK/offline provider configuration is not GitHub account-binding proof. Future support must separately control model-provider credential env and must not weaken GitHub-token gates when GitHub-hosted features are used. | BYOK can avoid GitHub auth for some use, but it does not identify a Copilot account profile. |

`GITHUB_TOKEN` is intentionally listed here even though repo-wide session docs treat broad non-provider tokens differently. Copilot documents `GITHUB_TOKEN` as a Copilot authentication source, so this is a **Copilot-specific child-process/profile-bound exception**, not a new global `mat session` environment scrub rule.

## Required future behavior

Before any Copilot product support, future implementation PRs must prove all of the following without token observation:

1. **Presence gate** — profile swap/freshness detects whether Copilot auth env vars are present by name only, without logging values.
2. **Ownership gate** — any injected token must come from a profile-bound source that declares the target profile/account; inherited parent-shell tokens are not profile-owned.
3. **Child-env scrub** — supported Copilot child processes must remove unrelated `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, and `GITHUB_TOKEN` unless the profile explicitly injects one.
4. **Fallback gate** — GitHub CLI fallback must be disabled or proven non-interfering for the supported flow without running or capturing `gh auth token` output.
5. **App-state cross-check** — token policy must not bypass explicit account binding from the Copilot app-state parser/proof flow.
6. **Platform proof compatibility** — macOS/Linux/Windows credential-store proof remains required for stored OAuth paths; ambient token policy alone does not unblock platform support.
7. **Docs drift check** — each implementation PR must recheck official Copilot CLI authentication docs and update this policy if precedence or fallback behavior changed.

## Forbidden observations and shortcuts

- Do not print, commit, hash, compare, or otherwise observe actual token values.
- Do not include token-shaped examples such as real OAuth/PAT prefixes with fake suffixes.
- Do not capture or commit `gh auth token` output.
- Do not rely on Copilot CLI transcript redaction as proof that `mat` safely handled a token.
- Do not infer account identity from environment variable names alone.
- Do not treat `GH_TOKEN` or `GITHUB_TOKEN` as Copilot profile material merely because they are present.
- Do not treat BYOK/offline provider configuration as GitHub account proof.
- Do not globally scrub broad `GITHUB_TOKEN` outside a Copilot-specific child environment unless a separate non-Copilot policy says so.

## Pass/fail matrix

| Scenario | Result | Reason |
| --- | --- | --- |
| Parent shell has `COPILOT_GITHUB_TOKEN` and future normal swap runs Copilot | Fail / hard-stop | Env token can override stored OAuth and is not proven profile-owned. |
| Parent shell has `GH_TOKEN` for another GitHub tool | Fail / hard-stop for Copilot flow | Copilot documents `GH_TOKEN` as an auth source, so it can bypass the profile. |
| Parent shell has `GITHUB_TOKEN` from GitHub Actions | Fail / hard-stop for Copilot flow | The token is automation context, not a `mat` Copilot profile binding. |
| Future `mat exec` injects one profile-owned `COPILOT_GITHUB_TOKEN` and scrubs competing env | May proceed to next gate | Still requires app-state and platform/fallback checks. |
| Future support relies on `gh auth token` fallback after env scrub | Fail unless proven non-interfering | Fallback can select a GitHub CLI account unrelated to the bound Copilot profile. |
| BYOK/offline mode with provider env only | Not GitHub account proof | May avoid GitHub auth for some features but does not prove profile identity. |
| Transcript redaction hides token values | Not proof | Redaction is output hygiene, not account binding or non-observation evidence. |
| Policy spec exists but no implementation | Policy gate only | Copilot remains blocked. |

## Stop conditions

Copilot remains blocked if any of these are true:

- Ambient auth precedence is unresolved for the target flow.
- A future implementation would inherit `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN` without proving profile ownership.
- A future implementation would rely on `gh auth token` output or GitHub CLI fallback without a no-secret, non-interference proof.
- App-state binding or credential-store selector proof can be bypassed by ambient tokens.
- BYOK/offline provider settings are used to claim GitHub account binding.
- PR text implies Copilot product support, safe profile swapping, or completed platform proof before all gates are complete.

## Product non-goals

- No `BUILTIN_CLI_DEFS` entry for `copilot`.
- No freshness adapter.
- No profile swap implementation.
- No `mat exec`, `mat session start`, or `mat session run` Copilot support.
- No env-secret source implementation.
- No credential-store read/write/delete code.
- No `gh auth token` invocation or transcript.
- No real token values, token-shaped fixtures, or local credential-store probes.

## Follow-ups

1. ✅ Env-secret source + command-scoped injection design documented in `docs/superpowers/specs/2026-06-15-env-secret-command-scoped-injection.md`; runtime/schema/storage implementation remains pending.
2. Human-opt-in or upstream-doc macOS/Linux Copilot account selector proof.
3. Windows Credential Manager synthetic CI spike + implementation RALPLAN.
4. Copilot app-state write-back policy.
5. Copilot prototype only after app-state, credential-store, Windows, ambient-token runtime, and env-secret runtime gates pass.
