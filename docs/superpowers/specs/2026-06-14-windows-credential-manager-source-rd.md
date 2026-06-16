# Windows Credential Manager source R&D contract (2026-06-14)

## Summary

This document started as a **docs-only R&D contract** for a future Windows Credential Manager source backend and now also records the follow-up implementation trail: a **non-product Windows-CI-only synthetic API proof**, a **feature-scoped Windows Node preflight**, an **internal-only backend proof**, and the later narrow public `win-credential` source primitive. It still does not claim Windows package/product, built-in CLI, session, Copilot, or Amp support.

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

## Feature-scoped Windows Node preflight (2026-06-16)

The second executable artifact is also intentionally outside product runtime:

- Workflow: `.github/workflows/windows-node-preflight.yml`
- Runner: `windows-latest`
- Scope: preflight-only forced Node dependency installation (`npm ci --force`, because the root package intentionally excludes `win32`), TypeScript typecheck, a curated Windows-safe core test subset for proof/env-secret/Amp boundary code, and any future `tests/core/windows-credential-manager*.test.ts` files when present
- Exclusions: no full `npm test`, no `tests/core/sources.test.ts` POSIX mode/`/usr/bin` assumptions, no `tests/core/cli-defs.test.ts` POSIX slash invariant, and no `tests/core/cli-defs-plugin.test.ts` on-disk plugin state assumptions until audited
- Product boundary: no `package.json` `win32` support, no main CI matrix expansion, no `SourceType`, no plugin schema/runtime, and no Copilot/Amp support

This preflight is evidence that future Windows Credential Manager backend work can use a targeted Windows Node lane. It is not evidence that the published package supports Windows or that any Windows credential source exists; the forced install is CI-only and exists precisely because package support remains darwin/linux.

## Internal-only backend proof (2026-06-16)

The third executable artifact was an internal backend proof, initially outside public source/schema/runtime wiring:

- Module: `src/core/windows-credential-manager.ts`
- Tests: `tests/core/windows-credential-manager.test.ts`
- Scope: internal TypeScript orchestration for `CRED_TYPE_GENERIC` read/write/exists/delete using a narrow `WindowsCredentialBridge`, fake-bridge rollback/error/redaction tests on all platforms, and real synthetic Windows Credential Manager integration tests on `windows-latest`
- Bridge: quarantined `PowerShellPInvokeWindowsCredentialBridge` that calls direct `CredReadW`, `CredWriteW`, `CredDeleteW`, and `CredFree`; secret material is passed through stdin JSON only, never argv
- Original product boundary for that artifact: no public `win-credential` source type, no plugin parser acceptance, no `sources.ts`/builtin wiring, no `package.json` `win32` support, no main CI Windows matrix expansion, and no Copilot/Amp support. The subsequent public-primitive PR intentionally changes only the source/parser/runtime primitive part of this boundary.

The follow-up public primitive now wires the backend into a narrow `win-credential` source. This is still not package-level Windows support: built-in CLIs, Copilot/Amp, `package.json` `win32`, and the main CI Windows matrix remain blocked.

What is not decided by public docs alone:

- The final package-level Windows support path for `mat`.
- Which built-in CLI definitions can safely rely on stable upstream Windows credential target/account contracts.
- Whether future Windows support needs additional installer/packaging and main-CI matrix changes.
- Any GitHub Copilot Windows target/account schema.

## Decision history and current boundary

The original R&D/synthetic-proof PR did **not** implement a product backend and allowed only a standalone Windows-CI-only synthetic proof script/workflow that exercised the Win32 Credentials Management API against a random `mat-ci/<run-id>/<guid>` target.

After the Windows Node preflight merged, the internal backend proof added a quarantined direct Win32 bridge. The next approved PR committed to the narrow public source primitive `win-credential` with exact-key plugin validation, metadata-only `exists`/doctor checks, account mismatch fail-closed behavior, and non-win32 unsupported reporting. This still does not add built-in CLI, Copilot, package-level win32, or session support.

## Why `cmdkey` is not the product backend plan

`cmdkey` is useful public evidence that Windows has a command-line surface for stored credentials, but it should not be the default product implementation path for `mat` without a separate security review.

Reasons:

- CLI output can be localized or format-shifted, making parsing brittle.
- Writes through command-line tools can create argv/history/log exposure risks if not carefully constrained.
- Rollback and cleanup semantics are less direct than a structured API call.
- Error classification is harder to make precise enough for fail-closed profile swapping.
- `mat` needs reliable target/type scoping comparable to macOS Keychain `service`/`account` and Linux Secret Service `service`/`account` semantics.

Preferred implementation direction: a small Win32 API bridge/helper around `CredReadW`, `CredWriteW`, and `CredDeleteW`, with `CredEnumerate` only if needed for diagnostic/ambiguity handling. The bridge design itself is a future PR.

## Public source shape

The public plugin/source primitive is intentionally narrow:

```ts
interface WindowsCredentialSource {
  type: 'win-credential';
  targetName: string;
  credentialType: 'generic';
  account: string;
  persist: 'session' | 'local-machine' | 'enterprise';
  saveAs: string;
}
```

Semantics:

- Lookup identity is `targetName + credentialType`; `account` is a required UserName metadata guard, not a lookup selector.
- Existing target/type entries with a different account fail closed before mutation and before normal secret reads.
- `persist` is the public write policy for new writes; rollback preserves backed-up persist metadata.
- Plugin parser accepts exact keys only and rejects unknown/secret-like fields.
- non-win32 detector/freshness/doctor/support report unsupported/blocked instead of ordinary missing.

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

- No built-in CLI uses `win-credential` yet.
- No package-level Windows support claim (`package.json` `os` remains darwin/linux) and no main CI Windows matrix expansion.
- No Copilot/Amp builtin, freshness adapter, profile swap, session, command-run, or target/account support is claimed by the public primitive alone.
- No trusted `mat session start/run` boundary for user plugin CLIs.
- A passing plugin validation report remains static schema/lint evidence, not proof that an upstream CLI will use the intended Windows credential target/account.

## Follow-up order

1. ✅ Non-product Windows-CI-only synthetic credential spike (`.github/workflows/windows-credential-manager-spike.yml`, `scripts/windows-credential-manager-synthetic.ps1`); product backend/support remained blocked.
2. ✅ Feature-scoped Windows Node/package-support preflight (`.github/workflows/windows-node-preflight.yml`); targeted typecheck/tests only, no `win32` package support claim.
3. ✅ Internal Windows Credential Manager backend proof (`src/core/windows-credential-manager.ts`, `tests/core/windows-credential-manager.test.ts`); direct Win32 bridge + synthetic Windows tests only, no public source/schema/runtime wiring.
4. ✅ Public Windows source schema/runtime wiring (`SourceType`/`sources.ts`/plugin parser`) with no builtin/package Windows support claim.
5. Copilot Windows target/account proof after backend exists and public wiring direction is settled.
6. ✅ Ambient token policy (`docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md`); runtime/env-secret implementation remains pending.
7. Copilot prototype only after all platform, ambient-token implementation, and env-secret gates pass.
