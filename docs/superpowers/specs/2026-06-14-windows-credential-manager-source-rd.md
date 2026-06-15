# Windows Credential Manager source R&D contract (2026-06-14)

## Summary

This document started as a **docs-only R&D contract** for a future Windows Credential Manager source backend and now also records a **non-product Windows-CI-only synthetic API proof**. It still does not implement a backend, does not add a new `SourceType`, does not add product runtime helpers, and does not claim Windows or Copilot product support.

The goal is to define the minimum safety, API, serialization, rollback, and CI requirements before `mat` can add a Windows credential-store source. The synthetic proof only validates that GitHub's Windows runner can perform scoped `CredWriteW`/`CredReadW`/`CredDeleteW` round-trips against a random repo-specific target.

## Official/public evidence rechecked

Sources rechecked during this PR:

- Microsoft Learn — `cmdkey`: <https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/cmdkey>
- Microsoft Learn — `CredReadW`: <https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw>
- Microsoft Learn — `CredWriteW`: <https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew>
- Microsoft Learn — `CredDeleteW`: <https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-creddeletew>
- Microsoft Learn — Credentials Management API: <https://learn.microsoft.com/en-us/windows/win32/secauthn/credentials-management>

Publicly documented contract relevant to `mat`:

- Windows exposes a Credentials Management API for reading/writing credentials.
- `CredReadW` reads a credential by target name and credential type from the current token/logon session credential set.
- `CredWriteW` creates or modifies a credential in the current token/logon session credential set.
- `cmdkey` can create, list, and delete stored credentials, including generic credentials.

## Non-product synthetic CI proof (2026-06-15)

The first executable artifact is intentionally outside product runtime:

- Workflow: `.github/workflows/windows-credential-manager-spike.yml`
- Script: `scripts/windows-credential-manager-synthetic.ps1`
- Runner: `windows-latest`
- Scope: one random target named `mat-ci/<run-id>/<guid>` with `CRED_TYPE_GENERIC` and `CRED_PERSIST_SESSION`
- APIs: direct `CredWriteW`, `CredReadW`, `CredDeleteW`, and `CredFree` P/Invoke declarations with `SetLastError=true` on failing Win32 calls
- Logging: phase/status plus safe target prefix/run id and Win32 error name/code only; no target GUID, secret value, credential blob, pointer, or raw credential output

This proof covers only these API semantics: missing read, write/read equality by exact UTF-16LE byte length, overwrite/read equality, delete, final missing read, and cleanup. It is not a Windows source backend and it does not prove any Copilot target/account contract.

What is not decided by public docs alone:

- The exact Node/TypeScript integration path for `mat`.
- How to represent Windows credential target/type fields in `Source` without committing to an unstable public schema too early.
- The exact product-runtime cleanup and rollback behavior for Windows credentials beyond the non-product synthetic API proof.
- Any GitHub Copilot Windows target/account schema.

## Decision

Do not implement a product backend in this PR.

This PR may add only a standalone Windows-CI-only synthetic proof script/workflow that exercises the Win32 Credentials Management API against a random `mat-ci/<run-id>/<guid>` target. Use this document as the contract for a future, separately reviewed Windows implementation. Any provisional name such as `win-credential` is **non-normative** and must not be treated as public schema until an implementation PR commits to it.

## Why `cmdkey` is not the product backend plan

`cmdkey` is useful public evidence that Windows has a command-line surface for stored credentials, but it should not be the default product implementation path for `mat` without a separate security review.

Reasons:

- CLI output can be localized or format-shifted, making parsing brittle.
- Writes through command-line tools can create argv/history/log exposure risks if not carefully constrained.
- Rollback and cleanup semantics are less direct than a structured API call.
- Error classification is harder to make precise enough for fail-closed profile swapping.
- `mat` needs reliable target/type scoping comparable to macOS Keychain `service`/`account` and Linux Secret Service `service`/`account` semantics.

Preferred implementation direction: a small Win32 API bridge/helper around `CredReadW`, `CredWriteW`, and `CredDeleteW`, with `CredEnumerate` only if needed for diagnostic/ambiguity handling. The bridge design itself is a future PR.

## Provisional source shape

This is a non-normative sketch only:

```ts
interface WindowsCredentialSource {
  type: 'win-credential'; // provisional name, not public schema
  targetName: string;
  credentialType: 'generic';
  account?: string;
  saveAs: string;
}
```

Open design questions before implementation:

- Whether `account` should exist for Windows or whether `targetName` must already encode the stable account selector.
- Whether target naming should be namespaced by `mat` for synthetic tests and by upstream docs for real CLIs.
- How to handle CLI-specific multi-account layouts that use one aggregate credential target.
- Whether plugin definitions should be allowed to declare Windows credentials before built-in runtime support exists.

## Serialization sketch

A future serialized profile backup should be explicit and redacted in errors:

```json
{
  "schemaVersion": 1,
  "targetName": "<target-name>",
  "credentialType": "generic",
  "account": "<optional-redacted-account>",
  "secret": "<stored-only-in-profile-file>"
}
```

Requirements:

- The secret must never appear in argv, logs, thrown errors, debug output, docs, or review artifacts.
- Corrupt backups must fail before writes if `secret` is missing or non-string.
- Error messages must include only safe structural fields such as target/type and redacted account labels.
- Serialization must preserve enough target/type/account metadata to restore the same Windows credential entry.

## Required backend behavior before implementation

A future Windows source backend must prove all of the following with synthetic credentials in Windows CI:

1. **Scoped read** — read exactly one credential by target/type and return `null` for a cleanly missing credential.
2. **Scoped write** — write only the requested target/type and never overwrite another target.
3. **Scoped delete/cleanup** — delete only the synthetic test target and tolerate idempotent cleanup after failures.
4. **Rollback** — if replacing an existing credential fails after backup, restore the previous credential or report both write and rollback failures without leaking secrets.
5. **Ambiguity handling** — if any enumeration/discovery path yields multiple possible targets, fail closed before destructive operations.
6. **Error taxonomy** — distinguish missing credential, access denied, unavailable platform API, malformed backup, write failure, delete failure, and cleanup failure.
7. **Memory handling** — native buffers returned by Windows APIs must be released according to the API contract; secret buffers should have the shortest practical lifetime.
8. **No source fallback** — backend absence or access denial must not silently fall back to another credential source unless that fallback is explicit in the CLI definition and documented as safe.

## Windows CI test matrix

Future implementation tests should run on `windows-latest` and use only synthetic targets with a repo-specific prefix, for example:

```text
mat-test/<run-id>/<case-name>
```

Minimum test cases:

| Case | Expected result |
| --- | --- |
| Missing synthetic target | Read returns null / absence result. |
| Write then read | Read returns the same synthetic secret, never printed. |
| Overwrite same target | New value replaces old value; old value is not emitted. |
| Delete target | Subsequent read returns missing. |
| Cleanup after failed test | Cleanup attempts delete for all synthetic targets and reports failures. |
| Malformed serialized backup | Fails before write; no target mutation. |
| Access denied / API unavailable simulation | Structured failure; no fallback to unsafe source. |
| Multiple candidate discovery simulation | Fail closed before write/delete. |

CI requirements:

- Tests must skip or isolate if Windows Credential Manager is unavailable in the runner.
- Synthetic target names must be unique per CI run.
- Cleanup must run in `finally`/afterEach even when assertions fail.
- Test logs must never include secret values.
- Any generated docs site changes from `npm run build:docs` must be committed or explained as unchanged.

## Forbidden implementation shortcuts

- Do not use `cmdkey` as product backend without a separate security review.
- Do not pass secrets in command-line arguments.
- Do not parse localized command output as the only source of truth for credential identity.
- Do not add a placeholder `SourceType` that cannot execute at runtime.
- Do not allow plugins to claim Windows credential support before runtime support and validation exist.
- Do not treat Windows backend availability as evidence for any particular CLI, including Copilot.
- Do not claim Copilot Windows support without a separate Copilot target/account proof.

## Copilot relationship

Windows Credential Manager support is necessary for cross-platform Copilot support, but not sufficient.

Copilot remains blocked until all of these are true:

- Windows source backend exists and passes synthetic Windows CI.
- Copilot’s Windows Credential Manager target/account schema is proven without secrets.
- Copilot app-state binding remains consistent with the credential-store selector.
- Ambient-token precedence (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, `gh auth token`) follows `docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md` and is implemented/controlled for the target flow.
- macOS/Linux proof, Windows proof, app-state write-back policy, and ambient-token policy all pass their gates.

## Stop conditions

Keep Windows source implementation blocked if any of these are true:

- The only proposed backend is `cmdkey` with shell parsing.
- Secrets would appear in argv, logs, thrown errors, or CI output.
- Synthetic Windows CI cannot clean up test credentials reliably.
- The implementation cannot distinguish access denied from missing credential.
- The implementation requires service-wide or target-prefix-wide destructive deletion.
- The implementation would add schema/plugin support without runtime behavior.
- PR text implies Windows backend implementation, Windows product support, or Copilot support before those gates are complete.

## Product non-goals

- No `SourceType` change in this PR.
- No plugin schema change in this PR.
- No Windows product runtime helper in this PR.
- No product credential reads/writes/deletes in this PR; only the standalone synthetic CI proof may touch a random `mat-ci/<run-id>/<guid>` target.
- No Copilot builtin, freshness adapter, profile swap, session, or command-run support in this PR.

## Follow-up order

1. ✅ Non-product Windows-CI-only synthetic credential spike (`.github/workflows/windows-credential-manager-spike.yml`, `scripts/windows-credential-manager-synthetic.ps1`); product backend/support remains blocked.
2. Windows source implementation RALPLAN.
3. Windows source implementation PR with synthetic CI tests.
4. Copilot Windows target/account proof after backend exists.
5. ✅ Ambient token policy (`docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md`); runtime/env-secret implementation remains pending.
6. Copilot prototype only after all platform, ambient-token implementation, and env-secret gates pass.
