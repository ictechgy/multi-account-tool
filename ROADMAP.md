# mat — Roadmap (v0.2+)

> v0.1.0 이후 합의된 향후 작업. 새 세션/PR 이 이어받을 수 있도록 컨텍스트와 결정 포인트를 정리한다.
> 각 항목은 별도 commit/PR 단위. 우선순위는 마지막 섹션 참고.

---

## Done

- ✅ **`mat exec <cli> <profile> -- <cmd...>`** — 시간 격리 실행. cli 별 lockfile 로 동시 swap 차단, stale lock 자동 복구, SIGINT/SIGTERM/SIGHUP 전달, `finally` 원복. 세션 격리는 아니며 `SIGKILL` 시 원복 불가는 한계로 명시.
- ✅ **`mat session start/list/stop`** — 세션별 격리 (아래 #2). env 주입(`CODEX_HOME` 등) + copy-isolate 로 터미널마다 다른 계정 **동시** 사용. 지원: Codex/Qwen/Kimi/Crush/Gemini CLI/Claude(Linux)/OpenCode(EXPERIMENTAL). 자격증명 격리 + 좁은 non-secret copy-isolate(Codex `config.toml`/`skills/`; write-back 없음), 종료 시 원자 재캡처, orphan 회수(pid+TTL). 설계/구현 합의: `docs/superpowers/specs/2026-05-30-session-isolation-design.md` + `.omc/plans/session-isolation.md` (ralplan consensus). macOS Claude(keychain)/Aider/Goose/Google Antigravity(`agy`)/plugin 은 미지원(명시 에러). OpenCode 는 broad XDG_DATA_HOME side effect 때문에 EXPERIMENTAL.

---

## Next — command-scoped session run follow-ups (2026-06-12)

`mat session start` 는 shell 전체를 격리하는 명령이라 OpenCode/Aider 처럼 config/env/argv credential 채널이 넓은 CLI 에서는 보안 경계가 아니다. 후속은 `session start` 확장이 아니라 **내장 CLI 한 프로세스만 실행하는** 새 명령으로 분리한다. 상세 R&D: `docs/superpowers/specs/2026-06-12-command-scoped-session-run-rd.md`.

1. ✅ **`mat session run <cli> <profile> -- [cli-args...]` framework** — 임의 shell/command 금지, builtin executable allow-list, 기존 session materialize/recapture lifecycle 재사용.
2. ✅ **OpenCode safer-run** — 현행 `session start opencode` 는 EXPERIMENTAL 유지. `session run opencode` 에서는 `attach`/`--dangerously-skip-permissions`/`--share`·`--command`/`--file`·`-f`/cwd·project-directory argv, `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG*`, `OPENCODE_DB`, `OPENCODE_MODELS_*`, `OPENCODE_TEST_*`, `OPENCODE_TUI_CONFIG`, `OPENCODE_PERMISSION`, provider credential env/project `.env`, local plugin/tool/command/mode/agent/skill dirs/config `instructions`/`skills`/`reference(s)`/`share`/deprecated `mode`/agent `prompt`·`permission`·`tools`/`plugin`/`mcp`/command channels/package manifests, global/managed/project/home `.opencode`/legacy `config`/`config.json`/`opencode.json{,c}`/`tui.json{,c}` 의 `{file:...}` substitution·plaintext/env-backed `apiKey`·credential header/option·provider endpoint·AWS profile 설정을 hard-stop 하고, child 의 AWS/Google ambient credential fallback 과 `.claude` prompt/skills fallback 을 scrub/disable.
3. ✅ **Aider partial-run** — `session start aider` 는 미지원 유지. `session run aider` 는 forced `--config <session>/command/aider.yml` + forced empty `--env-file <session>/command/.env` 로 command-scoped 실행만 열고, user config/env/model-sidecar argv(축약 long-option 포함), ambient `AIDER_*`, provider credential/endpoint env, AWS/Google/Vertex credential-chain env, child AWS/Google credential-chain scrub, credential-bearing `.env`, `~/.aider/oauth-keys.env`, non-empty/symlinked model sidecars, profile 내부 sidecar pointer/set-env, Bedrock/Vertex model selector/listing/alias 를 hard-stop.
4. ✅ **Antigravity research artifact** — 제품 지원은 계속 blocked. 현재 공개 문서는 system keyring + Google Sign-In fallback 만 설명하고 stable keyring service/account, credential redirect, safe recapture contract 를 공개하지 않는다. 결과는 `docs/superpowers/specs/2026-06-14-antigravity-auth-store-research.md` 에 기록했다. Linux private-keyring 실험은 성공해도 지원 승격 조건이 아니라 별도 research artifact 로만 둔다.
5. ✅ **Copilot/Amp auth-store research artifact** — 제품 지원은 계속 blocked. Copilot CLI 는 OS keychain/service `copilot-cli` + env fallback + `~/.copilot/config.json` application state(`loggedInUsers` 등)가 함께 움직여야 하며, Windows Credential Manager source 와 account 선택 flow 가 필요하다. Amp 는 `AMP_API_KEY` env-secret / command-scoped 실행 중심 설계가 필요하고 `~/.amp/oauth/` 는 MCP OAuth 용도라 계정 credential 로 취급하지 않는다. 결과는 `docs/superpowers/specs/2026-06-14-copilot-amp-auth-research.md` 에 기록했다.
6. ✅ **Copilot account-state RALPLAN** — 제품 지원은 계속 blocked. 다음 안전 단계는 explicit account binding + 최소 `~/.copilot/config.json` account-selection state 설계이며, `displayLogin`/`stableAccountId`/`storeAccountKey` 를 분리하고 plaintext fallback token 은 app-state 가 아닌 credential material 로 거부/별도 설계한다. 결과는 `docs/superpowers/specs/2026-06-14-copilot-account-state-plan.md` 에 기록했다.
7. ✅ **Copilot app-state fixture parser safety gate** — 제품 지원은 계속 blocked. `src/core/copilot-app-state.ts` 는 redacted `loggedInUsers` fixture 만 파싱하고 explicit account binding/duplicate-label disambiguation/token-like plaintext rejection 을 검증한다. `copilot` builtin, credential-store mutation, freshness/session/run wiring 은 추가하지 않았다.
8. ✅ **Copilot credential-store proof contract/R&D artifact** — 제품 지원은 계속 blocked. `docs/superpowers/specs/2026-06-14-copilot-credential-store-proof-contract.md` 가 macOS Keychain/Linux Secret Service account-selector 증명 요건, 금지 증거(raw `security`/`secret-tool` output, real labels, token-shaped strings), redacted report shape, pass/fail matrix 를 정의한다. 실제 platform proof 는 아직 pending 이며 `service=copilot-cli` 만으로는 account binding proof 가 아니다.
9. ✅ **Windows Credential Manager source R&D contract** — Windows 지원은 계속 blocked. `docs/superpowers/specs/2026-06-14-windows-credential-manager-source-rd.md` 가 Win32 Credentials Management API 기반 source backend 의 provisional shape, serialization/rollback, synthetic Windows CI matrix, failure taxonomy, 금지 shortcut(`cmdkey` product backend 등), Copilot stop condition 을 정의한다. `SourceType`/plugin schema/runtime 은 추가하지 않았다.
10. ✅ **Copilot ambient-token policy** — 제품 지원은 계속 blocked. `docs/superpowers/specs/2026-06-14-copilot-ambient-token-policy.md` 가 `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`/`gh auth token` 우선순위를 normal swap, `mat exec`, future session/command-scoped flow 별로 분리하고, Copilot 한정 `GITHUB_TOKEN` 예외·BYOK/offline 비증명·no-secret fallback gate 를 정의한다. env-secret source/runtime 구현은 추가하지 않았다.
11. ✅ **Env-secret command-scoped injection design** — 제품 지원은 계속 blocked. `docs/superpowers/specs/2026-06-15-env-secret-command-scoped-injection.md` 가 future `env-secret` source 개념, storage/UX gate prerequisite, `mat exec`/`mat session run` child-process injection contract, inherited env hard-stop/scrub, masking/audit/recapture/freshness 정책을 문서화한다. `SourceType`/plugin schema/runtime/프로필 저장소/builtin 지원은 추가하지 않았다.
12. ✅ **Env-secret storage threat model/UX gate** — 제품 지원은 계속 blocked. `docs/superpowers/specs/2026-06-15-env-secret-storage-threat-model-ux.md` 가 profile-owned environment secret 의 at-rest custody 위협모델, backend policy ranking, add/import/update/rotate/delete/export/backup UX, metadata-only observability, fail-closed platform matrix 를 문서화한다. 제품 schema/runtime/backend 는 계속 pending 이며 plaintext profile-file fallback 은 별도 opt-in PR 없이는 blocked 이다.
13. ✅ **Internal env-secret core + synthetic backend tests** — 제품 지원은 계속 blocked. `src/core/env-secret.ts` 가 internal binding/metadata/backend lifecycle, metadata-only audit event, child-env preparation, Windows-style env-name conflict checks, synthetic backend 를 정의하고 `tests/core/env-secret.test.ts` 가 synthetic value no-observation 과 product wiring boundary 를 검증한다. `SourceType`/plugin schema/profile storage/CLI/TUI/builtin/real backend/Amp/Copilot 지원은 추가하지 않았다.
14. ✅ **Env-secret public source/schema exposure RALPLAN** — 제품 지원은 계속 blocked. `docs/superpowers/specs/2026-06-15-env-secret-public-source-schema-plan.md` 가 future public `env-secret` source shape, identity/uniqueness rules, no-schema-only rule, existing `Source` consumer hard-stop matrix, future test requirements 를 문서화한다. `SourceType`/plugin parser/schema/product runtime/backend/Amp/Copilot 지원은 추가하지 않았다.
15. ✅ **Env-secret internal draft/refusal scaffold** — 제품 지원은 계속 blocked. `src/core/env-secret.ts` 가 future `env-secret` source draft validator, duplicate `saveAs`/normalized env-name checks, prohibited-field rejection, metadata-only refusal shape 를 추가하고 `src/core/cli-defs-plugin.ts` 는 `type: 'env-secret'` 를 closed parser/runtime diagnostic 으로 계속 거부한다. `SourceType`/plugin parser acceptance/product runtime/backend/Amp/Copilot 지원은 추가하지 않았다.
16. ✅ **Env-secret backend custody selection/proof contract** — 제품 지원은 계속 blocked. backend custody selection spec 이 candidate backend ranking, Linux Secret Service first-spike decision, metadata-only safe proof evidence, forbidden evidence, failure taxonomy, pass/fail proof matrix, redacted proof report template, public parser preconditions 를 문서화한다. `SourceType`/plugin parser acceptance/product runtime/backend/Amp/Copilot 지원은 추가하지 않았다.
17. ✅ **Env-secret Linux Secret Service backend spike** — 제품 지원은 계속 blocked. `src/core/env-secret-linux-secret-service.ts` 가 internal `linux-secret-service` backend adapter/proof report 를 추가하고, `src/core/os-keyring.ts` 는 env-secret 용 strict read/write/exists/delete helper 를 제공한다. 기존 os-keyring source 의 ENOENT soft fallback 은 유지하고, `type: 'env-secret'` plugin parser acceptance/product runtime/Amp/Copilot 지원은 추가하지 않았다.
18. ✅ **Env-secret public schema/runtime hard-stop** — 제품 지원은 계속 blocked. `SourceType`/plugin parser 는 metadata-only `type: 'env-secret'` 를 public schema 로 받되 public backend 는 `linux-secret-service` 로 제한하고 `accountKey` 를 필수로 요구한다. Internal/test-only `synthetic` backend 는 계속 public parser 에서 거부한다. `readSource`/`writeSource`/`sourceExists`/detector/freshness/doctor/snapshot/restore/switch/session/support 는 typed `unsupported-env-secret-source` 또는 safe metadata-only status 로 hard-stop 하며, product storage/command injection/profile UX/builtin Amp·Copilot 지원은 추가하지 않았다.
19. ✅ **Env-secret synthetic command-scoped runtime approval gate** — 제품 지원은 계속 blocked. `src/core/env-secret-command-runtime.ts` 는 internal helper 로 synthetic backend 기반 child-env construction, explicit `baseEnv`/`ambientEnv`, ambient conflict-before-load, metadata-only event 를 증명하고 `tests/core/env-secret-command-runtime.test.ts` 는 shell-free synthetic child `present`/`missing`, process/base/ambient isolation, negative no-spawn, repo-wide product boundary scan 을 고정한다. `mat exec`/`mat session run` injection, Linux Secret Service runtime injection, plugin runtime injection, profile UX, builtin Amp·Copilot 지원은 추가하지 않았다.
20. ✅ **Amp config hard-stop matrix** — 제품 지원은 계속 blocked. `src/core/amp-config-hard-stop.ts` 가 내부 pure analyzer 로 `AMP_API_KEY` ambient conflict, `--settings-file`, `--mcp-config`, user/workspace/managed settings 템플릿, MCP `command`/`args`/`env`/`url`/`headers`, `${VAR_NAME}` substitution, plugin/permission/MCP permission, `~/.amp/oauth/` MCP OAuth state 를 metadata-only hard-stop issue 로 검증한다. `tests/core/amp-config-hard-stop.test.ts` 는 value/path 비노출과 제품 wiring 부재를 고정한다. `amp` builtin, `mat exec amp`, `mat session run amp`, env-secret product runtime, LSS Amp wiring 은 추가하지 않았다.
21. ✅ **Windows Credential Manager synthetic CI proof** — 제품 지원은 계속 blocked. `.github/workflows/windows-credential-manager-spike.yml` + `scripts/windows-credential-manager-synthetic.ps1` 가 `windows-latest` 에서 synthetic target 으로만 `CredWriteW`/`CredReadW`/`CredDeleteW` API round-trip 을 증명한다. `SourceType`/plugin schema/runtime helper/Windows source backend/Copilot support 는 추가하지 않았다.
22. ✅ **Copilot account-selector proof report validator** — 제품 지원은 계속 blocked. `src/core/copilot-credential-proof.ts` 는 redacted proof-report metadata 만 검증하고 `tests/core/copilot-credential-proof.test.ts` + `tests/fixtures/copilot-credential-proof/` 는 macOS/Linux pass-shaped metadata, Windows blocked baseline, no secret/raw output, no product wiring boundary 를 고정한다. 실제 platform proof/probe 와 Copilot support 는 계속 pending 이다.
23. ✅ **Copilot macOS/Linux platform proof/probe design** — 제품 지원은 계속 blocked. `docs/superpowers/specs/2026-06-16-copilot-platform-proof-probe-design.md` 는 future human-opt-in proof 의 pre-flight evidence admissibility, macOS Keychain/Linux Secret Service proof goals, stop conditions, failure taxonomy 를 문서화한다. 실행 가능한 probe/script, 실제 credential-store read, raw local output, platform proof 완료, Copilot support 는 추가하지 않았다.
24. ✅ **Env-secret product runtime bridge / pre-command-surface gate** — 제품 command 지원은 계속 blocked. `src/core/env-secret-product-runtime.ts` 는 public `env-secret` metadata 를 Linux Secret Service runtime binding 으로 합성하고 `prepareEnvSecretCommandEnv()` 와 연결하는 internal bridge 를 추가했다. 테스트는 injected/mock backend 만 사용해 real Secret Service 를 읽지 않고, duplicate env-name / ambient·base conflict / raw `process.env` base-env / missing·failing backend / metadata·proof 비호출 / product surface import 부재를 고정한다. `mat exec`, `mat session run`, Amp/Copilot builtin, plugin runtime injection, plaintext fallback 은 추가하지 않았다. 설계 기록은 `docs/superpowers/specs/2026-06-16-env-secret-product-runtime-bridge.md`.
25. ✅ **Windows Node/package-support preflight** — Windows Credential Manager source 는 계속 blocked. `.github/workflows/windows-node-preflight.yml` 가 `windows-latest` 에서 preflight-only `npm ci --force`, `npm run typecheck`, curated Windows-safe proof/env-secret/Amp test subset 및 future `windows-credential-manager*.test.ts` 를 실행해 future backend PR 의 Node/TypeScript preflight lane 을 만든다. `package.json` `os` 는 darwin/linux 그대로이고 main CI matrix 도 macOS/Linux 그대로다. `SourceType`/plugin schema/runtime helper/Windows source backend/Copilot support 는 추가하지 않았다.
26. ✅ **Windows Credential Manager internal backend proof** — Windows 제품 지원은 계속 blocked. `src/core/windows-credential-manager.ts` 가 내부 전용 `WindowsCredentialBridge` 와 격리된 PowerShell/PInvoke bridge 로 `CRED_TYPE_GENERIC` read/write/exists/delete 및 rollback/error redaction 을 구현하고, `tests/core/windows-credential-manager.test.ts` 가 fake-bridge 단위 검증과 Windows synthetic Vitest round-trip/cleanup 을 고정한다. `SourceType`/plugin parser/`sources.ts`/builtin/Copilot/package win32/main CI Windows support 는 추가하지 않았다.
27. ✅ **Public `win-credential` source primitive/runtime wiring** — Windows 제품 지원은 계속 blocked. `SourceType`/plugin parser/`sources.ts` 는 exact-key `type: 'win-credential'` (`targetName`, `credentialType: 'generic'`, required `account`, required `persist`, `saveAs`) 를 수용하고 Windows Credential Manager backend 로 연결한다. `exists`/doctor 는 metadata-only inspect 경로를 사용하고 account mismatch 는 secret read/write 전에 fail-closed 한다. non-win32 detector/freshness/doctor/support 는 ordinary missing 대신 unsupported/blocked 로 보고한다. Builtin CLI, Copilot/Amp, `package.json` win32 support, main CI Windows matrix, session trust boundary 는 추가하지 않았다.
28. ✅ **Copilot Windows metadata-report gate** — 제품 지원은 계속 blocked. `src/core/copilot-credential-proof.ts` 는 Windows `pass` claim 을 값 없는 `windowsCredentialBindingProof`(`targetName` status/policy, `credentialType: 'generic'`, account/UserName guard status/policy) 가 있을 때만 metadata-pass 로 수용한다. `targetName + credentialType` 은 Windows lookup identity 이고 account/UserName 은 guard 일 뿐 selector 가 아니며, 실제 Copilot Windows TargetName/account-guard platform proof 와 builtin/profile swap/package win32 지원은 계속 pending 이다.
29. ✅ **Copilot proof metadata admission gate** — 제품 지원은 계속 blocked. `src/core/copilot-proof-metadata-admission.ts` 는 redacted proof report 와 value-free human-review checklist 를 순수 함수로 평가해 `admissible-metadata`/`blocked`/`rejected`/`deferred` taxonomy 를 고정한다. report validator 통과와 metadata admission 은 여전히 platform proof 가 아니며, 실제 macOS/Linux evidence collection, executable probe, Windows TargetName/account-guard evidence, Copilot builtin/profile swap/package support 는 계속 pending 이다.
30. ✅ **Copilot human evidence review-package gate** — 제품 지원은 계속 blocked. `src/core/copilot-human-evidence-package.ts` 는 redacted report/checklist 를 review-package manifest 에 묶는 얇은 순수 계층으로, `macos-linux-platform-evidence` 는 macOS/Linux target subset 만, `windows-target-account-guard-review` 는 Windows target 만 허용하고 manifest/checklist/pass-platform exact match 를 요구한다. package `admissible-metadata-package` 는 platform proof 가 아니며 실제 macOS/Linux evidence collection, human-reviewed Windows TargetName/account-guard evidence, executable probe, Copilot builtin/profile swap/package support 는 계속 pending 이다.

---

## 1. 다른 AI CLI 도구 스왑 지원

### 현재 (v0.4-pre) 내장 CLI

| id | credential 위치 |
| --- | --- |
| `claude` | macOS Keychain (`Claude Code-credentials`) |
| `codex` | `~/.codex/auth.json` |
| `gemini` | `~/.gemini/oauth_creds.json` + `google_accounts.json` |
| `aider` | `~/.aider.conf.yml` |
| `kimi` | `~/.kimi/config.toml` |
| `qwen` | `~/.qwen/settings.json` + `~/.qwen/.env` |
| `crush` | `~/.config/crush/crush.json` + `~/.local/share/crush/crush.json` |
| `opencode` | `~/.local/share/opencode/auth.json` (OS 공통, XDG 표준) |
| `goose` | **macOS**: Keychain (service `goose`, account `secrets`) + `~/.config/goose/secrets.yaml` + `config.yaml` / **그 외**: yaml 2개 |

### 확장 대상 universe

`lterm` README 가 정리한 agent 리스트와 같은 부분 채택:

- **file-based ✅ (v0.3.x 빌트인)**: ~~Aider~~, ~~Kimi~~, ~~Qwen~~, ~~Crush~~, ~~OpenCode~~ — 8개 file-based 후보 (PR 1 단계 병렬 조사) 중 mat 의 file source 추상화로 표현 가능한 5개 완료.
- **account-scoped Keychain ✅ (v0.4-pre 빌트인)**: ~~Goose~~ — PR-A (`KeychainSource.account` optional 필드) 덕분에 service `goose`/account `secrets` scope 가능. macOS 기준 keychain + secrets.yaml + config.yaml multi-source.
- **mat 추상화 추가 확장 필요 (보류)** — PR #30 quad-review 에서 wrong-account 위험 합의:
  - **GitHub Copilot CLI** (PR #30 closed; research: `docs/superpowers/specs/2026-06-14-copilot-amp-auth-research.md`) — multi-account 지원 (`/user switch` / `copilot login`) 인데 PR-A `account` 필드만으로는 부족 (어느 account 가 swap 대상인지 사용자가 명시해야 함 → 새 UI flow 필요). OS keychain service `copilot-cli` 는 공개됐지만 account/Secret Service attribute schema 는 제품 구현 전에 검증 필요. Windows Credential Manager primitive(`win-credential`) 와 value-free Windows metadata-report gate 는 생겼지만, human-reviewed Copilot Windows TargetName/account-guard evidence, `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN`/`gh auth token` fallback, `~/.copilot/config.json` 의 `loggedInUsers` 등 application state 통제가 아직 필요하다.
  - **Amp** (Sourcegraph, `@ampcode/cli`; research: `docs/superpowers/specs/2026-06-14-copilot-amp-auth-research.md`) — documented non-interactive credential 은 `AMP_API_KEY` env-secret 이고, Amp settings/MCP config 는 `~/.config/amp/settings.json{,c}` 와 workspace `.amp/settings.json{,c}` 에서 실행/credential-bearing override 를 만들 수 있다. `~/.amp/oauth/` 는 remote MCP OAuth token store 로 문서화되어 primary Amp account credential 로 swap 하면 안 된다. mat 의 file/keychain/os-keyring source 추상화로 표현 불가능.
  - **후속 PR 묶음**: Copilot account-state plan, redacted app-state fixture/parser, credential-store proof contract, proof-report validator, platform proof/probe design, proof metadata admission gate, human evidence review-package gate, Windows source R&D, Windows synthetic CI spike, Windows Node preflight, Windows internal backend proof, public `win-credential` source primitive/runtime wiring, Copilot Windows metadata-report gate, ambient token policy, env-secret design/storage/core/schema/backend proof/backend spike/public hard-stop 는 완료. 남은 항목은 실제 macOS/Linux platform evidence collection, human-reviewed Copilot Windows TargetName/account-guard evidence, executable probe security review, 그 후 Copilot/Amp 재PR.
  - **추가 후속 업데이트**: backend custody selection/proof contract, internal Linux Secret Service backend spike, public env-secret schema/runtime hard-stop, internal synthetic command-scoped runtime approval gate 완료. Amp config hard-stop matrix, Windows Credential Manager synthetic CI proof, Windows Node/package-support preflight, Windows internal backend proof, public Windows source schema/runtime wiring, Copilot proof-report metadata validator, Copilot platform proof/probe design, Copilot Windows metadata-report gate, Copilot proof metadata admission gate, Copilot human evidence review-package gate, env-secret product runtime bridge 까지 완료했다. 다음 code PR 은 실제 macOS/Linux platform evidence collection, human-reviewed Windows evidence, 또는 executable probe security review 를 RALPLAN 으로 재검토한다.
- **Cursor Agent** — keychain service name 공식 미공개 + `~/.cursor/cli-config.json` 만 swap 으로는 credential 격리 안 됨 (실제 token 은 keychain). 공식 service name 확정까지 plugin 권장.
- **Kiro, Jules** — credential 패턴 미조사.

### 작업 분해

1. **각 CLI 의 credential 위치 조사** — file path, env var, keychain entry. PR 별 1 CLI.
2. **`BUILTIN_CLI_DEFS` 에 항목 추가** — 기존 `Source` 추상화 (`file` / `keychain`) 로 충분한지 확인.
3. **plugin 확장 메커니즘** — `~/.multi-account-tool/cli-defs/*.json` 으로 사용자 정의 CLI. JSON schema + 런타임 validator (`validateProfileName` 같이).
4. **shell-export 기반 CLI** (env var 만 지원하는 도구) — `mat exec` (아래 #3 참고) 흐름으로 표현.

### 알려진 어려움

- credential 형식이 OAuth 토큰만 있는 게 아님 (API key, session cookie, multi-file SQLite 등)
- 일부는 디스크가 아니라 OS keyring/secret-service. Linux 는 별도 백엔드 필요.
- 일부는 env var 만 지원 → swap 모델로 표현 불가 → `mat exec` shell hook 필요.

---

## 2. 세션별 로그인 격리 (lterm 세션 마다 다른 계정)

### 동기

현재 mat 은 OS 전역으로 한 시점에 한 계정. 사용 시나리오:

- 터미널 A: `lterm start personal` → Claude personal 계정
- 터미널 B: `lterm start work` → Claude work 계정
- 두 세션이 **동시 실행** 가능해야 함

현재 모델로는 불가능 (마지막 swap 이 OS 전역 덮어씀).

### 핵심 unknown — 각 CLI 가 credential 위치 override 를 env var 로 지원하는가?

조사 항목 (각 CLI 의 docs 또는 source code 확인 필요):

- **Claude Code**: Keychain service name 을 env 로 override 가능한지?
  - Keychain 항목명 자체를 `Claude Code-credentials-<session>` 같이 분기할 수 있는지가 핵심.
  - 안 되면 OS 전역 한계 — 세션 격리 불가능 (현재 모델 유지).
- **Codex**: `CODEX_HOME` 또는 `CODEX_AUTH_FILE` 같은 env var?
- **Gemini**: `GEMINI_CONFIG_DIR` ?
- **Aider**: `--config-file <path>` CLI 옵션 + `OPENAI_API_KEY` env 직접 export — 세션 재배치 env 부재로 BLOCKED

### 설계 시나리오

#### A. env var 지원 CLI (file path override)
- `mat session start <session-name> --profile <profile>` 명령
- mat 가 임시 디렉토리 `~/.multi-account-tool/sessions/<session>/codex/` 에 자격증명 복사
- 새 shell 을 `CODEX_HOME=~/.multi-account-tool/sessions/<session>/codex` env 로 spawn
- 그 shell 안에서 실행되는 CLI 는 격리된 자격증명 사용
- 세션 종료 시 임시 디렉토리 정리

#### B. Keychain 기반 (Claude)
- service name 자체를 `Claude Code-credentials-<session>` 으로 분기 가능한지가 관건
- Claude Code 가 service name 을 hardcode 한다면 불가능
- 가능하다면 mat 가 session 별 항목 생성 + 환경변수로 Claude 에게 알려줌

#### C. 불가능한 CLI
- 세션 격리 불가 명시. 사용자가 "이 CLI 는 한 번에 한 계정만 가능" 알 수 있게 UI 표시.

### 우선 작업
1. 각 CLI 의 env var/path override 조사 (각자 docs 또는 source code)
2. 가능한 CLI 부터 `mat session start` 명령 추가
3. session 디렉토리 cleanup (orphan 세션 정리)

---

## 3. lterm 과의 조화

### lterm 컨텍스트
- `@ictechgy/lterm` v1.0.25+ (사용자 본인 작품, npm: `@ictechgy/lterm`; mat profile shim PR #144 merged)
- tmux 호환 PTY 세션 데몬 (`lterm start`, `lterm resume`, `lterm send-keys`)
- 빌트인 agent shim: `lterm claude` / `lterm codex` / `lterm agy` / `lterm gemini` 등 (`mat` 기준 Google Antigravity/`agy` 자격증명 swap·session 격리는 native keyring + 안정 redirect 부재로 별도 미지원)

### 통합 시나리오

#### A. `mat exec <cli> <profile> -- <cmd>` ✅ 구현됨 (Done 섹션 참고)

1. 일시적으로 `<profile>` 로 swap (현재 활성 자동 백업)
2. `<cmd>` 실행
3. 명령 종료 후 원래 profile 로 자동 복원

사용 예:
```bash
lterm start work
lterm send-keys "mat exec claude work-acc -- claude" Enter
```

격리는 아니지만 **시간 분할**: 한 세션 안에서 한 명령 동안만 다른 계정. CLI 가 시작 시 토큰 읽고 메모리 보관하는 경우 동작.

구현 세부:
- 인자 형식은 `<cli> <profile> -- <cmd...>` (모호함 없음).
- cli 별 lockfile (`~/.multi-account-tool/locks/<cli>.lock`) 로 동시 실행 직렬화.
- 활성 프로필이 설정되지 않은 cli 에서는 사용 불가 (라이브 자격증명 보존 보장 못함).

#### B. lterm session hook (있다면) — 보류
- 세션 시작/종료 hook API 가 있는지 확인
- 있으면: 세션 이름 → mat profile 자동 매핑
- 현재 결정: hook API 의존 없이 shim wrapper 만으로 진행. 세션 격리형 hook 은 native keyring/redirect unknown 해결 전까지 재방문.

#### C. lterm agent shim 확장 ✅
- `lterm claude --profile <name>` / `--mat-profile <name>` 옵션
- 내부에서 `mat exec <cli> <profile> -- <agent-binary> ...` 호출 후 agent 실행
- lterm 측 변경 완료: `ictechgy/light_terminal` PR #144
- allowlist: `claude`, `codex`, `opencode`, `aider`, `goose`, `crush`, `gemini`, `kimi`, `qwen`
- `agy` 등 blocked/unsupported agent 는 command resolution 전에 거부

### 결정 포인트
- lterm hook API 의존 vs shim wrapper 만으로 → shim wrapper 로 완료 (후자가 의존성 작음)
- 시간 격리 (A) 만 vs 세션 격리 (B+#2 결합) → 후자는 #2 의 unknown 해결 선행 필요

---

## 결정 필요 항목 (조사/논의 후 확정)

- [ ] 각 추가 CLI 의 credential 위치/포맷 (조사 필요)
- [ ] credential override env var 지원 여부 (CLI 별)
- [ ] plugin/extension 메커니즘: JSON config vs JS module
- [x] lterm hook API 의존 vs shim wrapper 만으로 진행 → shim wrapper 채택/구현 (`ictechgy/light_terminal` PR #144)
- [ ] `mat exec <profile> -- <cmd>` 인터페이스 (subprocess env 격리 한계)
- [ ] session 디렉토리 누수 정리 정책 (orphan TTL?)

---

## 제안 우선순위

| 순서 | 작업 | 사유 |
| --- | --- | --- |
| 1 | ~~`~/.multi-account-tool/cli-defs/*.json` plugin~~ ✅ | 사용자가 mat 코드 변경 없이 새 CLI 추가 (PR #14) |
| 2 | ~~Aider 내장 지원~~ ✅ | text-based config 라 가장 단순 (v0.3 빌트인) |
| 3 | 다른 CLI 조사 + 내장 추가 | Cursor / Goose / Copilot 등 |
| 4 | ~~세션 격리 (#2)~~ ✅ | env var override 지원 CLI 부터 완료. Keychain/native-keyring CLI 는 별도 R&D |
| 5 | ~~`mat session run` framework~~ ✅ | OpenCode/Aider 를 shell 이 아닌 command-scoped 경계로 안전하게 일부 unblock |
| 6 | ~~OpenCode safer-run~~ ✅ | broad `XDG_DATA_HOME` EXPERIMENTAL 을 좁히고 config/env/project 우회 hard-stop |
| 7 | ~~Aider partial-run~~ ✅ | forced config/env-file + env/argv/dotenv/OAuth-key/provider-chain/model-sidecar hard-stop 로 제한 지원 |
| 8 | ~~Antigravity auth-store research artifact~~ ✅ | 제품 지원은 upstream auth-store/redirect/recapture 계약 확인 전까지 계속 blocked |
| 9 | ~~lterm shim wrapper (`lterm claude --profile X`)~~ ✅ | lterm repo 협력 완료 (`ictechgy/light_terminal` PR #144) |

---

## v0.1 에서 의도적으로 처리 안 한 항목 (재방문 가치)

quad-review (2026-05-23) 에서 수용된 trade-off:

- **`security` CLI `-w <value>` argv 노출** — argv 가 `ps -ef`/audit 로그에 노출. CLI 자체 한계. native Keychain API binding (Rust/Swift) 로 대체 시 해결 가능하나 큰 변경.
- **`-A` ACL 완화** — Claude 가 자기 토큰 못 읽는 회귀 회피용. opt-in `-T <path>` whitelist 모드로 v0.2 검토.
- **평문 backup** — `~/.multi-account-tool/profiles/` 의 자격증명이 평문 JSON. native Keychain 으로만 보관하거나 (위와 동일 dependency) age/passphrase 기반 암호화 옵션.
- **용어 일관성** — snapshot (내부 API) / 캡처 (UI 액션) / 백업 (switch 부수효과) / 가져오기 (초기 import) 가 의도된 차별화. UI 사용자 피드백 받으면 통일 검토.
