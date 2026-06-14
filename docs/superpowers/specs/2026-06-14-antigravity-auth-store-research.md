# Antigravity CLI auth-store research — blocked support note (2026-06-14)

## Summary

Google Antigravity CLI (`agy`) remains **blocked** for `mat` profile swap, freshness, `mat session start`, and `mat session run` support.

Current public evidence is enough to explain the block, but not enough to implement safe support: Antigravity CLI documents system-keyring authentication and Google Sign-In fallback, yet does not publish a stable keyring service/account contract, token profile format, credential redirect environment variable, or recapture story that `mat` can rely on.

This note is a research artifact only. It does **not** add product support.

## Evidence checked

### Official public repository

- Repository: <https://github.com/google-antigravity/antigravity-cli>
- Latest release visible during review: `1.0.8` (2026-06-12).
- Public repository contents visible through the GitHub API: `README.md`, `CHANGELOG.md`, `agy-cli-demo.gif`, and `examples/`.
- The public README says Antigravity CLI authenticates through the system keyring and falls back to Google Sign-In when no active session exists.
- The same README documents `/logout` as the sign-out flow, but does not document keyring service/account names, a profile-scoped token store, or a credential/data redirect contract.

### Local non-secret observations

Commands run:

```bash
agy --version
agy --help
agy auth --help
agy statusline --help
agy changelog --help
```

Observed locally:

- `agy --version` returned `1.0.8`.
- `agy --help` listed general flags and subcommands such as `changelog`, `install`, `models`, `plugin`, `plugins`, and `update`.
- No `auth` or `statusline` subcommand help was exposed; those invocations printed the top-level help.
- The top-level help did not advertise a credential-store redirect flag or environment variable.

## Non-evidence / rejected signals

These observations are **not** sufficient for `mat` support:

- Files or caches under `~/.gemini/antigravity-cli/`.
- A locally observed `antigravity-oauth-token` file.
- Broad `HOME`, XDG, or guessed `ANTIGRAVITY_*` environment redirects.
- Local keyring entry discovery, even if a user can find one on their machine.
- Gemini CLI credential paths such as `~/.gemini/oauth_creds.json`.

Antigravity CLI is not a Gemini CLI credential source. Treating Gemini files or incidental Antigravity cache files as the credential boundary could cause wrong-account behavior.

## Stop conditions

`mat` must keep `agy` blocked unless upstream documents all of the following:

1. A stable credential-store contract, including platform-specific keyring service/account names or a profile-scoped file/token store.
2. A CLI-specific redirect or profile selection contract that can isolate credentials without broad `HOME` or unrelated XDG side effects.
3. A safe recapture/logout/rotation story so `mat` can preserve account changes without reading or printing secret values.
4. Platform support boundaries for macOS, Linux, and Windows that can be tested without interactive login flows.

## Product state

- `mat support agy --json` may explain the blocked state.
- User plugin definitions with id `agy` must not override this known-blocked boundary.
- `agy` must not be added to `BUILTIN_CLI_DEFS`, freshness adapters, session roots, or `session run` executables until a new RALPLAN revisits the threat model with upstream evidence.

## Revisit checklist

If upstream documentation changes, start a new RALPLAN before implementation and capture:

- Exact upstream version/date and source URLs.
- Platform-specific credential-store contract.
- Redirect/profile-selection contract.
- Non-secret tests proving no credential values are read or printed.
- Failure and rollback behavior for missing keyring entries, logout, token rotation, and plugin id collisions.
