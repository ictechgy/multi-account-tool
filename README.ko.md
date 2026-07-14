# multi-account-tool (`mat`)

[English](README.md) | 한국어

📖 **문서 사이트:** [ictechgy.github.io/multi-account-tool](https://ictechgy.github.io/multi-account-tool/)

하나의 TUI에서 여러 AI CLI 계정(Claude Code, Codex, Gemini CLI, Aider, Kimi, Qwen, Crush, OpenCode, Goose, Grok Build)을 전환한다. 계정마다 프로필을 하나씩 저장해 두고, 매번 `logout` → `login`을 반복하는 대신 키 한 번으로 바꾼다.

`mat`은 보수적으로 동작한다. macOS Keychain 항목을 백업하고, 부분 실패는 롤백하며, 파일은 원자적으로 쓴다. 평문 자격증명 백업 위험을 분명히 알리고, swap 전 자격증명 freshness(OAuth refresh-token rotation 포함)도 점검한다. 라이브 자격증명이 저장된 프로필과 불일치한 경우 실제 swap 전에 재캡처 / 폐기 / 취소 중 하나를 선택하게 한다.

```
╭ Multi-Account Tool ────────────────────────────────╮
│  AI CLI 계정 스위처                                 │
╰─────────────────────────────────────────────────────╯

  > Claude Code            [활성: personal] ✓
    Codex CLI              [활성: work]     ✓
    Gemini CLI              [활성: personal] ✓
```

---

## 왜 만들었나

- Claude Code, Codex, Gemini 같은 CLI를 여러 계정(개인 / 회사 / 팀)으로 쓸 때
- 컨텍스트를 바꿀 때마다 `logout` / `login`을 반복하기 지쳤을 때
- 작업을 시작하기 전에 현재 활성 계정을 명확히 확인하고 싶을 때

## 어떻게 동작하나

`mat`은 각 CLI의 **자격증명만** swap한다. hooks, agents, `CLAUDE.md`, 대화 이력, 설정 같은 나머지는 그대로 둔다.

| CLI | 자격증명 위치 | 전환 방식 |
| --- | --- | --- |
| Claude Code | macOS Keychain (`Claude Code-credentials`) | Keychain 항목 swap |
| Codex CLI | `~/.codex/auth.json` | 파일 swap |
| Gemini CLI | `~/.gemini/oauth_creds.json`, `google_accounts.json` | 파일 swap |
| Aider | `~/.aider.conf.yml` | 파일 swap |
| Kimi CLI | `~/.kimi/config.toml` | 파일 swap |
| Qwen Code CLI | `~/.qwen/settings.json`, `~/.qwen/.env` | 파일 swap |
| Crush | `~/.config/crush/crush.json`, `~/.local/share/crush/crush.json` | 파일 swap |
| OpenCode | `~/.local/share/opencode/auth.json` (OS 공통, XDG 표준) | 파일 swap |
| Goose | macOS Keychain / Linux Secret Service (service `goose`, account `secrets`) + `~/.config/goose/secrets.yaml` + `config.yaml` | Multi-source (account-scoped Keychain/os-keyring; Linux는 `secret-tool`로 swap — 아래 참고) |
| Grok Build | `~/.grok/auth.json` | 파일 swap (profile-swap-only) |

### OAuth Rotation 안전성 매트릭스

일부 CLI는 **OAuth refresh-token rotation**(RFC 6749 권장 방식)을 사용한다. refresh token이 사실상 1회용이라, 다음 refresh 성공 후 provider가 이전 token을 무효화할 수 있다. 이때 `mat`이 오래된 snapshot을 복원하면 provider가 token을 "already used"로 거부하고 사용자는 다시 로그인해야 한다. 아래 표는 `mat`이 지원하는 CLI별 위험도와 안전 워크플로를 정리한 것이다.

| CLI | 인증 방식 | rotation 위험 | `mat` 안전 워크플로 |
| --- | --- | --- | --- |
| Codex CLI | OAuth (`tokens.refresh_token`, `tokens.account_id`) | 🔴 높음 — token revoke 재현됨 | swap 전 `mat freshness codex` 점검 / 일회성 명령은 `mat exec` |
| Gemini CLI | OAuth (`refresh_token` + `google_accounts.json.active`) | 🔴 높음 | Codex와 동일 |
| OpenCode | provider별 OAuth (`provider.refresh`, `provider.accountId`) | 🔴 높음 | Codex와 동일 |
| Claude Code | macOS Keychain (Anthropic OAuth) | 🟢 완화됨 — identity-aware adapter (`subscriptionType` + macOS keychain account) | `mat exec` 또는 `mat freshness claude` (high-confidence rotation 분류) |
| Goose | macOS Keychain + `secrets.yaml` / `config.yaml` (provider 라우팅) | 🟢 완화됨 — identity-aware adapter (provider key 매트릭스 + keychain account) | `mat freshness goose`가 source별 결과 보고, identity-aware |
| Grok Build | Browser/OIDC `~/.grok/auth.json` | ⚠️ 미확인 — identity adapter 없이 fallback byte-diff만 사용 | TUI 프로필 전환만 사용(`grok` 선택 후 대상 프로필 선택); 선택한 프로필을 신뢰하기 전 config/env/project override를 검토 |
| Aider / Kimi / Qwen / Crush | 정적 API key | 🟢 없음 | 일반 swap으로 충분 — 단 환경변수 / project-local 설정이 `mat`의 swap을 우회할 수 있음 (아래 "플랫폼 지원" 참고) |

`mat freshness [<cli>] [--profile <name>] [--json]` 명령으로 swap 전 라이브와 활성 프로필의 자격증명을 비교한다. exit code 0 = 안전: 모든 source가 `fresh`이거나 adapter가 high/medium confidence로 identity 유지 `rotated`를 확인한 경우다. exit code 1 = swap 전 조치가 필요한 상태: `stale`, fallback/byte-diff 기반 low-confidence `rotated`, `inflight`, 또는 프로필/source 부재를 뜻한다. 장기 실행 세션에는 `mat exec`를 권장한다. 명령 종료 후 자동으로 이전 프로필을 복원하지만, `mat` 자체가 `SIGKILL`을 받으면 복원이 일어나지 않는다(보안 섹션 참고).

> **OAuth rotation 대응:** TUI의 swap 흐름은 swap 직전 라이브 freshness를 점검하고, 차이를 감지하면 **재캡처 / 폐기 / 취소** 3옵션 dialog를 표시한다. 재캡처는 라이브 자격증명을 `snapshotLiveToProfile`로 활성 프로필에 저장한 뒤 swap하고, 폐기는 자동 snapshot을 건너뛰고 swap한다(데이터 손실). 취소는 swap을 실행하지 않는다. `mat exec`는 종료 시 라이브 자격증명을 swap-target 프로필로 재캡처한 뒤 원래 활성 프로필로 복원하므로, 명령 실행 중 발생한 rotation도 보존된다 — `SIGINT`/`SIGTERM`/`SIGHUP`까지 보호한다. `SIGKILL`은 OS 보장상 trap이 불가능하므로 다음 `mat` 호출의 stale-recovery가 사용자에게 안내한다. Claude/Goose identity-aware adapter는 `high`/`medium` confidence로 rotation과 다른 계정을 구분해, 안전한 swap에서 `[low conf]` dialog noise를 제거한다.

### 플랫폼 지원

| CLI | macOS | Linux | Windows | Overrides / 알려진 제약 |
| --- | --- | --- | --- | --- |
| Claude Code | ✅ | ✅ | ❌ | macOS는 Keychain, Linux는 `~/.claude/.credentials.json`. `mat session`은 Linux에서 `CLAUDE_CONFIG_DIR`로 지원; macOS Keychain은 세션 격리 불가 |
| Codex CLI | ✅ | ✅ | ⚠️ 미검증 | `~/.codex/auth.json` (cross-platform file path) |
| Gemini CLI | ✅ | ✅ | ⚠️ 미검증 | `~/.gemini/oauth_creds.json` + `google_accounts.json`; `mat session`은 `GEMINI_CLI_HOME` + `.gemini` envSubdir 사용 |
| Google Antigravity (`agy`) | ❌ blocked | ❌ blocked | ❌ blocked | Gemini CLI 자격증명 source가 아니다. 현재 공개 문서는 system keyring 인증 + Google Sign-In fallback만 설명하며, 안정적인 keyring service/account, token profile, credential redirect, recapture 계약은 공개하지 않는다. `~/.gemini/antigravity-cli/`의 설정/cache와 관찰 가능한 `antigravity-oauth-token` 파일만으로는 안전 지원 근거가 부족하다. [auth-store research note](./docs/superpowers/specs/2026-06-14-antigravity-auth-store-research.md) 참고. |
| Aider | ✅ | ✅ | ⚠️ 미검증 | `mat session start`는 계속 미지원(credential-dir env 없음). `mat session run aider`는 partial support: `mat`이 `--config <session>/command/aider.yml` + `--env-file <session>/command/.env`를 강제하고 알려진 argv/env/dotenv/OAuth-key/model-sidecar/provider-chain 우회를 hard-stop |
| Kimi CLI | ✅ | ✅ | ⚠️ 미검증 | **env override**: `MOONSHOT_API_KEY` 등이 `~/.kimi/config.toml`을 우회 |
| Qwen Code CLI | ✅ | ✅ | ⚠️ 미검증 | profile swap과 `mat session start qwen`은 `QWEN_HOME`을 재지정하지만 advisory 범위다. Qwen은 shell/project/ancestor/home 설정 source를 계속 사용할 수 있다. 완전한 v0.19.3 auth/source 계약을 fail-closed할 수 있을 때까지 `mat session run qwen`은 의도적으로 미지원이다. |
| Crush | ✅ | ✅ | ⚠️ 미검증 | **project-local override**: CWD의 `./.crush.json` / `./crush.json`이 `~/.config/crush/*`보다 우선; `CRUSH_GLOBAL_*` env도 우선 |
| OpenCode | ✅ | ✅ | ⚠️ 미검증 | OS 공통 XDG 경로(`$XDG_DATA_HOME/opencode/auth.json`, 기본 `~/.local/share/opencode/auth.json`). `mat session start`는 broad `XDG_DATA_HOME` 기반 **EXPERIMENTAL**; `mat session run opencode`는 command-scoped로 알려진 local env/config 우회를 hard-stop |
| Goose | ✅ | ✅ os-keyring | ❌ | macOS Keychain / Linux Secret Service(`goose`/`secrets`, `secret-tool` 경유) + `~/.config/goose/*.yaml`. Linux는 기본적으로 os-keyring을 포함하며 `secret-tool`(libsecret-tools) + keyring daemon이 필요 — 미설치/daemon-down 시 stale YAML로 조용히 swap하지 않고 **명시 에러**를 낸다. Goose는 libsecret *라이브러리*로 keyring에 접근하므로 secret-tool CLI 부재가 keyring 미사용을 뜻하지 않는다. file backend라면 `GOOSE_DISABLE_KEYRING=1` 설정 시 `mat`이 os-keyring을 생략하고 `secrets.yaml`을 swap한다. Windows Credential Manager 미지원 |
| Grok Build | ✅ | ✅ | ⚠️ 미검증 | 현재 지원은 기본 signed-in browser/OIDC 토큰 파일 `~/.grok/auth.json`만 `grok-auth.json`으로 swap한다. `mat session start/run grok`은 미지원이다. `~/.grok/config.toml`의 model `api_key`/`env_key`, `XAI_API_KEY`, `GROK_*` auth/model env, `GROK_HOME`, project `.grok/config.toml`, MCP credentials는 `auth.json`을 override/우회할 수 있으므로 선택한 프로필을 신뢰하기 전에 unset/검토해야 한다. |

"⚠️ 미검증" = swap 로직은 platform-agnostic file I/O라 동작 가능성이 있지만, 본 프로젝트 CI는 macOS + Ubuntu만 검증한다. Windows 경로는 각 CLI의 공식 문서 기반 추정이며 실제 실행은 검증하지 않았다. patch / 버그 리포트 환영.

CLI 하나의 정확한 지원 경계를 보려면 `mat support <cli>`(또는 `mat explain <cli>`)를 실행한다. 현재 swap, freshness, session 지원 상태와 caveat, ambient override 위험, 마지막으로 확인한 upstream 가정을 함께 출력한다.

foreground 프로필 전환이나 `mat exec` 중 provider API-key env var, project-local config 파일 같은 high-confidence ambient 우회 채널이 보이면 `mat`은 경고를 출력한다. 이 경고는 정보성이다. 아직 **차단하거나 scrub하지는 않는다**. 의도한 override라면 계속 진행하면 되고, 아니라면 선택한 프로필을 신뢰하기 전에 표시된 env/config source를 unset 하거나 제거하라.

#### 왜 Grok session isolation은 아직 켜지 않았나

Grok Build 지원은 현재 의도적으로 **profile-swap-only**다. xAI 공개 Build 문서([Getting Started](https://docs.x.ai/build/overview), [Enterprise Deployments](https://docs.x.ai/build/enterprise))는 여러 자격증명·config·계정 선택 채널을 설명한다: browser OIDC/device auth, external auth-provider command, `XAI_API_KEY` 직접 API-key 인증, `~/.grok/config.toml`의 model-level `api_key` / `env_key`, managed/requirements config layer, project-visible instructions/plugins/hooks/MCP server, 그리고 이 모든 discovery view를 보여주는 `grok inspect`. 즉 `~/.grok/auth.json`은 여러 채널 중 하나일 뿐이므로, 그 파일만 세션 디렉토리로 복사하거나 redirect해도 `mat session` 자식이 선택한 profile만 사용한다고 증명할 수 없다.

향후 `mat session run grok`은 별도 설계가 필요하다. 가능한 방향은 (1) API-key-only 경계를 만들고 browser/OIDC, config, env, project, plugin, hook, MCP override 채널을 hard-stop하거나, (2) upstream이 명확한 recapture semantics를 가진 Grok credential/config-root redirect를 제공하는 것이다. 그 전까지는 TUI에서 Grok 프로필을 전환하고(`grok` 선택 후 대상 프로필 선택), 활성 profile을 신뢰하기 전에 위 override source를 unset/검토하라.

### 전환 흐름 (데이터 손실 없음)

0. **swap 전 freshness 점검** — 라이브 자격증명이 활성 프로필 저장본과 drift(OAuth refresh 토큰 회전 등)된 상태면, 아래 1~3 단계 전에 **재캡처 / 폐기 / 취소** dialog가 먼저 표시된다. CLI별 분류 신뢰도는 위의 "OAuth Rotation 안전성 매트릭스" 참고.
1. 현재 라이브 자격증명을 **현재 활성 프로필**에 자동 스냅샷
2. 선택한 프로필의 저장된 자격증명을 라이브 위치로 **원자적으로 복원**
3. 활성 프로필 포인터 업데이트

multi-source CLI(예: Gemini의 두 파일)에는 **부분 실패 롤백**도 적용된다. 한 source 복원에 실패하면 이미 복원된 source를 라이브 백업으로 되돌려, 라이브가 절반만 새 프로필인 상태를 막는다.

---

## 설치

### Homebrew (macOS 권장)

```bash
brew tap ictechgy/mat
brew install mat
```

### npm

```bash
npm install -g multi-account-tool
```

### 소스에서 빌드

```bash
git clone https://github.com/ictechgy/multi-account-tool.git
cd multi-account-tool
npm install
npm run build
npm link
```

### 설치 확인

```bash
mat --version                  # 설치된 semver 출력
mat --help                     # subcommand 목록 (TUI 옵션 + `mat exec` / `mat session` / `mat plugin` / `mat freshness` / `mat doctor`)
node scripts/smoke-test.mjs    # 소스 체크아웃 전용 — read-only smoke test (CLI 정의 로드 + path resolve 확인, 자격증명 미수정)
```

smoke test는 read-only라 활성 `mat` 프로필이 있는 환경에서도 안전하다.

---

## 사용

```bash
mat              # TUI 실행
mat --version    # 설치된 버전 출력
mat --help       # 짧은 사용법 (subcommand: exec / session / plugin / freshness / doctor)
```

TUI가 열리면 **CLI 선택 → 프로필 선택 → 전환** 순서로 진행한다.

### 첫 실행

이미 로그인된 자격증명이 감지되면 `default` 프로필로 가져올지 묻는다. 한 번 답하면 다음 실행부터 자동으로 다시 묻지 않는다 (수동 캡처는 언제나 가능).

### 새 계정 추가하기

1. `mat` → CLI 선택 → `a` (새 프로필) → 이름 입력 (예: `work`)
2. 새 프로필에서 `Enter`를 눌러 활성화한다. 라이브 자격증명이 **활성 프로필**의 저장본과 drift(OAuth refresh 토큰 회전 등)된 상태라면 swap 직전에 **재캡처 / 폐기 / 취소** dialog가 표시된다 — 위의 전환 흐름 + OAuth Rotation 안전성 매트릭스 참고.
3. 별도 터미널에서 해당 CLI의 로그인 명령 실행 (`claude`, `codex`, `gemini` 등). 라이브 자격증명이 새 계정 것으로 덮어쓰인다.
4. `mat`으로 돌아와 같은 프로필에서 `c`(캡처)를 누른다. 새 라이브 자격증명이 프로필에 저장된다.
5. 이후로는 `Enter`만으로 프로필 사이를 자유롭게 전환한다.

### 키바인딩

| 화면 | 키 | 동작 |
| --- | --- | --- |
| 어디서나 | `q` / `Ctrl+C` | 종료 |
| 어디서나 | `Esc` | 뒤로 |
| 홈 / 프로필 | `↑ ↓` | 이동 |
| 홈 / 프로필 | `Enter` | 선택 / 전환 |
| 프로필 | `a` | 새 프로필 추가 |
| 프로필 | `c` | 포커스된 프로필에 현재 라이브 자격증명 캡처 |
| 프로필 | `r` | 이름 변경 |
| 프로필 | `d` | 삭제 |
| Freshness dialog | `r` / `Enter` | 재캡처 (swap 전에 라이브를 활성 프로필에 저장) |
| Freshness dialog | `d` | 폐기 (자동 snapshot 건너뜀 — 데이터 손실) |
| Freshness dialog | `c` / `Esc` | swap 취소 |

### `mat exec` — 한 명령에 한해 프로필 swap

```bash
mat exec <cli> <profile> -- <cmd...>
```

`<profile>`로 일시 swap → `<cmd>` 실행 → 명령 종료 시 원래 활성 프로필로 자동 복원.

```bash
# 한 번의 Claude 세션만 work 프로필로 실행, 종료 후 personal로 복원
mat exec claude work -- claude

# lterm과 조합 (선택 — `npm install -g @ictechgy/lterm`으로 별도 설치 필요)
lterm send-keys "mat exec claude work -- claude" Enter
```

동작:

- `<cli>`에 이미 활성 프로필이 설정되어 있어야 한다(먼저 TUI로 라이브 자격증명 캡처).
- CLI별 lockfile(`~/.multi-account-tool/locks/<cli>.lock`)로 동일 CLI의 `mat exec`가 동시에 race하지 않도록 직렬화한다. 비정상 종료로 남은 stale lock은 자동 복구한다.
- 자식에 `SIGINT` / `SIGTERM` / `SIGHUP`을 전달하고, 자식의 종료 코드/시그널을 그대로 반영한다.
- **종료 시 라이브 자격증명을 `<profile>`으로 재캡처한 뒤 원래 활성 프로필로 복원**한다(`<cmd>`가 OAuth refresh rotation 등으로 토큰을 갱신했을 가능성 보존). 재캡처는 기본 10s timeout(`MAT_EXEC_RECAPTURE_TIMEOUT_MS` env override)으로 keychain prompt hang을 제한한다.
- 복원은 `finally` 블록에서 일어나 정상 종료, 에러, trap 가능 시그널 모두에서 실행된다. **단 `mat` 자체가 `SIGKILL`(또는 `SIGSEGV` / `SIGBUS` 등 trap 불가 시그널)을 받으면 복원은 일어나지 않는다** — 다음 `mat` 실행 시 stale lock을 자동 회수하고, 사용자에게 "라이브 자격증명이 이전 활성 프로필이 아닌 `<profile>`의 것일 수 있음"을 stderr로 안내한다(정책 B: warn + drop).

이는 **시간 격리**이지 세션 격리가 아니다. 자식이 실행되는 동안 OS 전역 자격증명은 `<profile>`의 것이다. 두 터미널에서 서로 다른 `mat exec`를 동시에 띄우면 lock으로 직렬화된다. 터미널별로 서로 다른 계정을 동시에 써야 한다면 `mat session`을 사용하라.

종료 코드:

| 코드 | 의미 |
| --- | --- |
| `0` | 자식 정상 종료 0 (원복 성공) |
| `2` | 사용 오류 (`UsageError` — spawn 전 검증 실패) |
| `74` | `mat` 자체의 복원 실패 (`restoreError`) — 자식 결과는 stdout/stderr로 출력됨 |
| `75` | 다른 `mat exec`가 CLI lock 보유 중 (`LockHeldError` — spawn 전) |
| `128+N` | 자식이 시그널 `N`으로 종료(예: SIGINT면 `130`) |
| `1` | 자식이 종료 코드 `1`로 끝났거나, `mat` 자체가 spawn 전후로 예상치 못한 에러 발생 |
| _그 외 (예: `3`, `42`)_ | 자식의 non-zero 종료 코드를 그대로 전달 |

참고: `2` / `74` / `75`는 `mat` 자체의 에러 모델로 예약되어 있다(spawn 전 검증 / lock 경합 / spawn 후 복원 실패). 그 외의 `128` 미만 non-zero 코드는 모두 자식의 종료 코드를 투명하게 전달한다. `74`가 `mat`의 복원 실패인지 자식의 exit 74인지 헷갈리면 stderr의 `restoreError` 로그를 확인한다.

### `mat session` — 세션별 격리 (터미널마다 다른 계정, 동시에)

```bash
mat session start <cli> <profile>   # <profile>로 격리된 subshell 실행
mat session run <cli> <profile> -- [cli-args...]
                                  # builtin CLI executable을 격리 env로 직접 실행
mat session run <cli> <profile> --check|--explain [--json] -- [cli-args...]
                                  # spawn 없이 정확한 session-run validator 사전 점검
mat session list [--json]           # 실행 중 / orphan 세션 목록
mat session stop <id>               # 세션 종료 또는 orphan 정리
mat status [--json]                 # dashboard/statusline용 active profile + session 요약
```

`mat exec`(lock으로 직렬화되는 시간 격리)와 달리 `mat session`은 **진짜 동시 격리**를 제공한다. 두 터미널이 같은 CLI의 *다른* 계정을 동시에 쓸 수 있다:

```bash
# 터미널 A
mat session start codex work        # CODEX_HOME이 격리 디렉토리 → "work" 계정

# 터미널 B (동시)
mat session start codex personal    # 독립 격리 디렉토리 → "personal" 계정
```

**메커니즘 — env 주입 + copy-isolation.** `mat session start`는 `$SHELL`을 실행하면서 CLI의 config-directory env(예: `CODEX_HOME`)가 `~/.multi-account-tool/sessions/<id>/` 아래 새 세션 전용 디렉토리를 가리키게 한다. `mat`은 선택한 프로필의 자격증명을 그곳에 `0600` 권한으로 복사하므로, subshell 안의 CLI는 격리된 계정만 읽는다.

작은 non-credential allow-list는 세션 로컬 스냅샷으로 함께 복사될 수 있다. Codex의 경우 `config.toml`과 `skills/`가 격리된 `CODEX_HOME`으로 복사되어, live `~/.codex` tree를 공유하지 않고도 사용자 skill을 사용할 수 있다. 종료 시 `mat`은 (OAuth rotation 등으로) 바뀐 자격증명만 프로필로 재캡처한 뒤 세션 디렉토리를 삭제한다. OS 전역 자격증명과 `mat exec` lock은 건드리지 않으므로 세션은 서로 간섭하지 않고 동시에 실행된다.

`mat session run`은 같은 materialize → env 주입 → 재캡처 → cleanup lifecycle을 쓰지만 shell을 열지 않는다. `mat`이 `<cli>`에 대응하는 builtin executable(예: `codex`)을 선택하고 `[cli-args...]`를 직접 넘긴다. `--` 뒤는 임의 shell 명령이 아니라 선택된 CLI의 argv다. 현재 이 command-scoped 경계는 안전한 run path가 확인된 builtin(Codex, Kimi, Crush, Gemini CLI, Linux Claude, OpenCode safer-run, Aider partial-run)에만 열려 있다. Qwen은 의도적으로 제외된다.

실행 전에는 `mat session run <cli> <profile> --check -- [cli-args...]`(또는 `--explain`)으로 **동일한** 지원 여부, profile, executable, Aider, OpenCode hard-stop validator를 점검할 수 있다. 이 경로는 CLI를 spawn하지 않고 session directory도 만들지 않는다. 실제 실행 preflight를 통과하면 exit `0`, validation blocker가 있으면 `1`, 사용법/parser 오류는 `2`다. 자동화가 필요하면 그 `--check`/`--explain` 명령에 `--json`을 붙여 blocker, phase, 선택 executable, profile 존재 여부, 정확한 argv를 포함한 report를 받는다.

dashboard/statusline 용도로 `mat status --json`은 active profile과 session 요약을 담은 안정 schema-v1을 출력한다. active profile에는 capture 시점에 저장된 masked account/email fingerprint나 allowlisted tier/provider-mode 같은 identity metadata가 포함될 수 있지만, status는 credential file이나 keyring entry를 즉석에서 파싱하지 않는다. `mat session list --json`은 owner/child 상태와 root env 이름만 포함한 schema-v1 session lifecycle entry(`active` / `orphan` / `unknown`)를 출력하며, session root 절대 경로는 내보내지 않는다. 변이를 수행하는 session lifecycle 명령은 `~/.multi-account-tool/audit.jsonl`에 best-effort redacted JSONL event를 append한다. persistent audit entry는 profile/session identifier를 hash 처리하고 secret-like string을 redact한다.

#### Prompt/statusline snippets

프롬프트 렌더러는 `mat status --json`을 사용할 수 있지만, 매 redraw 때 uncached로 실행하지 말아야 한다. status report는 session liveness를 검사할 수 있다. 아래 예시는 2초 동안 cache하고, `mat` 실행이나 JSON parsing이 실패하면 빈 출력으로 끝나며, 표시 전용이다. `mat status --json`만 호출하고 `~/.multi-account-tool`, credential file, keyring, `mat freshness`, `mat doctor`를 직접 읽거나 실행하지 않는다.

공유 helper를 `~/.config/mat/statusline.zsh` 같은 파일에 둔다:

```zsh
: ${MAT_STATUS_CACHE_TTL:=2}
: ${MAT_STATUS_CACHE:="${XDG_CACHE_HOME:-$HOME/.cache}/mat/status.json"}

mat_status_cached() {
  local now mtime cache_dir tmp
  cache_dir="$(dirname "$MAT_STATUS_CACHE")" || return 0
  mkdir -p "$cache_dir" 2>/dev/null || return 0

  now=$(date +%s)
  if [[ -r "$MAT_STATUS_CACHE" ]]; then
    mtime=$(stat -f %m "$MAT_STATUS_CACHE" 2>/dev/null)
    if [[ -z "$mtime" || "$mtime" == *[!0-9]* ]]; then
      mtime=$(stat -c %Y "$MAT_STATUS_CACHE" 2>/dev/null || echo 0)
    fi
    if [[ -n "$mtime" && "$mtime" != *[!0-9]* ]] && (( now - mtime < MAT_STATUS_CACHE_TTL )); then
      cat "$MAT_STATUS_CACHE"
      return 0
    fi
  fi

  tmp="${MAT_STATUS_CACHE}.$$.$RANDOM"
  if command mat status --json > "$tmp" 2>/dev/null && mv "$tmp" "$MAT_STATUS_CACHE" 2>/dev/null; then
    cat "$MAT_STATUS_CACHE"
  else
    rm -f "$tmp"
  fi
}

mat_statusline() {
  mat_status_cached | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const r=JSON.parse(s||"{}");const profiles=(r.activeProfiles||[]).map(p=>`${p.cliId}:${p.profileName}`).join(" ");const sessions=r.sessions||{};const warn=(sessions.orphan||sessions.unknown)?`⚠${sessions.orphan||0}/${sessions.unknown||0}`:"";const out=[profiles,warn].filter(Boolean).join(" ");if(out)process.stdout.write(out);}catch{}});' 2>/dev/null
}
```

zsh `RPROMPT`에서 사용:

```zsh
source ~/.config/mat/statusline.zsh
setopt prompt_subst
RPROMPT='$(mat_statusline)'
```

tmux에서 사용:

```tmux
set -g status-right '#(zsh -lc "source ~/.config/mat/statusline.zsh && mat_statusline")'
```

Starship에서 사용:

```toml
[custom.mat]
command = 'zsh -lc "source ~/.config/mat/statusline.zsh && mat_statusline"'
when = 'command -v zsh >/dev/null 2>&1 && command -v mat >/dev/null 2>&1 && command -v node >/dev/null 2>&1'
format = '[$output]($style) '
style = 'cyan'
```

기본 formatter는 `codex:work gemini:personal ⚠1/0`처럼 짧게 출력한다. 경고 숫자는 `orphan/unknown` session 수다. 다른 모양이 필요하면 Node formatter 부분만 바꾸면 된다.

**지원 CLI** (자격증명 디렉토리를 env로 재배치할 수 있는 것):

| CLI | env var |
| --- | --- |
| Codex | `CODEX_HOME` |
| Qwen Code | `QWEN_HOME` |
| Kimi | `KIMI_SHARE_DIR` |
| Crush | `CRUSH_GLOBAL_CONFIG` + `CRUSH_GLOBAL_DATA` |
| Gemini CLI | `GEMINI_CLI_HOME` (`.gemini` envSubdir) |
| Claude Code (Linux 전용) | `CLAUDE_CONFIG_DIR` |
| OpenCode (**EXPERIMENTAL**) | `XDG_DATA_HOME` (`opencode` envSubdir; broad XDG side effect) |

**`mat session start` 미지원** (안전한 자격증명 재배치 env 없음; `session start`가 명시 에러): macOS `claude`(Keychain service name env override 불가), `aider`(provider env / CLI args / project-local config 등 세션 재배치 불가 채널; 대신 더 좁은 `mat session run aider` partial support 사용), `goose`(keychain/OS-keyring 자격증명은 env 디렉토리 리다이렉트 불가), `grok`(profile-swap-only `~/.grok/auth.json`; config/env/project/MCP 우회는 별도 session-isolation 설계 필요), Google Antigravity / `agy`(native keyring + 안정적인 CLI 전용 credential redirect 부재; `HOME` redirect는 너무 광범위), 그리고 사용자 **플러그인** CLI(빌트인 전용 신뢰경계).

종료 코드는 `mat exec`와 동형: `0` 성공, `2` 사용법 에러, `74` 재캡처 실패, `128+N` 자식 시그널 `N` (self-raise), 그 외 자식 종료 코드 전달.

**한계 (사용 전 필독):**

- **자격증명은 격리, 복사된 config는 세션 로컬.** `mat`은 자격증명을 세션에 복사하고 종료 시 자격증명만 재캡처한다. 비밀값이 아닌 read-mostly data는 좁은 allow-list로 복사될 수 있지만, 이 복사본도 격리된 스냅샷이며 write-back 되지 않는다. 현재 Codex는 `config.toml`과 `skills/` 스냅샷을 세션에 받아 skill을 사용할 수 있고, 세션 안에서 바꾼 config나 skill은 종료 시 버려진다. symlink, hardlink, 특수파일, 너무 깊거나 큰 tree, 항목 수가 너무 많은 tree는 shell spawn 전에 실패한다. 그 외 history·cache·session·대부분 config는 세션 안에서 만들어지고 **종료 시 폐기**된다. 실제 config/history 보존이 중요한 장기 단일 계정 작업은 `mat exec`, 동시 다계정은 `mat session`을 권장.
- **세션 자식은 ambient credential env를 scrub한다.** profile copy-isolation이 부모 shell의 env로 우회되지 않도록 `mat session start`와 `mat session run`은 고신뢰 provider/API endpoint env 및 AWS/GCP credential-chain env를 상속하지 않는다. 가능한 경우 AWS/GCP shared-credential fallback은 무해한 값으로 hardening한다. `GITHUB_TOKEN` 같은 broad non-provider token은 scrub하지 않는다. 의도적으로 provider env가 필요하다면 `mat session start`의 경우 세션이 열린 뒤 interactive 세션 안에서 직접 export 하라. command-scoped `mat session run`에는 시작 후 export할 shell이 없으므로 필요한 env는 호출되는 CLI가 지원하는 컨텍스트에서 설정되어야 하며, Aider/OpenCode safer-run은 알려진 provider env/config 우회를 전달하지 않고 hard-stop할 수 있다.
- **Aider `session run`은 partial support; `session start aider`는 계속 미지원.** `mat`은 프로필의 `aider.yml`을 session command directory에 materialize한 뒤 builtin `aider` executable만 실행하면서 `--config <session>/command/aider.yml`와 빈 `--env-file <session>/command/.env`를 강제한다. child의 AWS/Google ambient credential-chain fallback도 scrub한다(`AWS_SHARED_CREDENTIALS_FILE=/dev/null`, `AWS_CONFIG_FILE=/dev/null`, `AWS_EC2_METADATA_DISABLED=true`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null` 등). 사용자 `--config`/`-c`, `--env`/`--env-file`, `--api-key`, provider key/endpoint 인자(`--openai-api-key`, `--anthropic-api-key`, `--openai-api-base`, `--openai-base-url` 등), `--set-env`, model sidecar 인자(`--model-settings-file`, `--model-metadata-file`), ambient `AIDER_*` env, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_BASE` 같은 provider credential/endpoint env, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEXAI_PROJECT` 등 AWS/Google/Vertex credential-chain env, generic `*_API_KEY`/`*_TOKEN`/`*_SECRET_KEY`, credential-bearing home/project `.env` 후보, non-empty/symlinked `~/.aider/oauth-keys.env`, non-empty/symlinked Aider model sidecar(`.aider.model.settings.yml`, `.aider.model.metadata.json`), profile 내부 model-sidecar pointer, profile `set-env`, host AWS/Google credential chain에 의존하는 Bedrock/Vertex model selector/listing 요청 또는 alias는 hard-stop한다. 이는 command-scoped credential boundary이며 Aider home/config 전체 격리 claim이 아니다.
- **Qwen은 profile-swap + advisory session-start 지원이며 `session run qwen`은 비활성화되어 있다.** `mat session start qwen`은 `QWEN_HOME`을 격리된 profile copy로 재지정하지만, Qwen의 shell environment, project/ancestor dotenv 탐색, legacy/home configuration, settings 기반 auth routing, interactive working-directory 변경을 가둔다는 주장은 하지 않는다. Ambient detection은 app 기반 switch, `mat exec`, `mat doctor`에서만 실행되고 `session start`에서는 실행되지 않는다. 비대화형 profile 선택에는 제어된 profile swap(`mat exec qwen <profile> -- qwen ...`)을 사용하되 command-scoped credential boundary로 간주하지 않는다. 고정한 Qwen v0.19.3 all-auth-source 계약을 fail-closed parse/recheck할 수 있을 때까지 `mat session run qwen`은 계속 제공하지 않는다.
- **OpenCode `session start`는 계속 EXPERIMENTAL; 가능하면 `session run` 권장.** OpenCode는 upstream에 `OPENCODE_DATA_DIR`가 없어 `XDG_DATA_HOME`을 사용한다. `session start`에서는 이 env가 subshell 전체에 적용되므로 다른 XDG 도구(예: Crush)가 세션 안에서 data/credential을 쓰면 ephemeral 세션 디렉토리에 기록됐다가 종료 시 사라질 수 있다. `mat session run opencode ...`는 더 좁게 builtin `opencode` executable만 실행하고, child의 AWS/Google ambient credential fallback을 scrub하고 OpenCode `.claude` prompt/skills loading을 끄며, 알려진 local config/env/plugin/tool/MCP/command/argv 우회가 있으면 hard-stop한다(`attach`, `pr`, `--dangerously-skip-permissions`, `--share`, `--command`, `--file`/`-f`, `--dir`/`--cwd`/path-like directory/symlink 같은 cwd/project-directory arg, `OPENCODE_AUTH_CONTENT`, `OPENCODE_CONFIG*`, `OPENCODE_DB`, `OPENCODE_MODELS_*`, `OPENCODE_TEST_HOME`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`, `OPENCODE_TUI_CONFIG`, `OPENCODE_PERMISSION`, `*_API_KEY`/AWS key/`GOOGLE_APPLICATION_CREDENTIALS`/`SNOWFLAKE_CORTEX_PAT` 같은 provider credential env 또는 project `.env` assignment, `OPENCODE_DISABLE_CLAUDE_CODE*`로 차단되는 `.claude` prompt/skills fallback, `{file:...}` substitution/`apiKey`/credential header·option/provider env reference/provider endpoint override/provider `npm`/AWS profile/`instructions`/`skills`/`reference(s)`/`share`/deprecated `mode`/agent `prompt`·`permission`·`tools`/`plugin`/`mcp`/`shell`/`formatter`·`lsp` command 설정을 포함한 legacy `config`, `config.json`/`opencode.json{,c}`/`tui.json{,c}` global/managed/project/home `.opencode` config, local plugin/tool/command/mode/agent/skill directory, OpenCode `package.json` manifest, symlink/unreadable config 후보, macOS managed preference 후보).
- **`SIGKILL`**은 세션 디렉토리를 orphan으로 남긴다(trap 불가, `mat exec`와 동일). 다음 `mat session` 호출이 회수한다(소유 프로세스 사망 — 프로세스 시작서명으로 **PID 재사용까지 식별** — **그리고** 세션 시작시각·디렉토리 mtime 둘 다 1h 초과 시).
- **부모 신뢰 전제:** 격리는 `~/.multi-account-tool`과 그 부모가 신뢰됨을 전제한다. `~/.multi-account-tool` 자체가 symlink로 바꿔치기된 경우는 범위 밖이다.
- **같은 프로필 동시 2세션:** 재캡처는 best-effort 프로필 단위 advisory lock(`locks/recapture/<cli>/<profile>.lock`)으로 backup → stage → commit 구간을 가능한 한 직렬화한다. lock 획득 실패/timeout 시에는 세션 종료를 막지 않고 lock-free 2-phase commit으로 degrade한다. 이 경우 단일 자격증명 CLI는 last-writer-wins, 멀티 자격증명 CLI(Qwen/Crush)는 **같은 계정**의 서로 다른 세션 파일이 일시적으로 섞일 수 있다. wrong-account credential을 쓰지는 않으며 다음 사용 시 자가 치유된다. 결정적 재캡처가 필요하면 터미널마다 다른 프로필 사용을 권장.
- **`mat session stop`**은 소유 프로세스의 신원(PID + 시작서명)을 확인할 수 있을 때만 `SIGTERM`을 보낸다. 확인 불가 시(드묾 — 예: `ps` 미사용 가능) PID를 재사용한 무관 프로세스를 죽일 위험을 피해 세션을 건드리지 않고 재시도를 안내한다.

### `mat freshness` — swap 전 안전성 점검

```bash
mat freshness [<cli>] [--profile <name>] [--json] [--check-only]
```

라이브 자격증명과 활성(또는 지정) 프로필 저장본을 비교해 swap 전에 drift를 보고한다. `<cli>`를 생략하면 현재 활성 프로필이 있는 모든 builtin/plugin CLI를 보고한다. CI chain(`mat freshness && deploy.sh`)으로 wrong-profile 복원으로 인한 OAuth `refresh_token` revoke 사고를 사전 차단할 수 있다.

```bash
# 긴 Claude 세션 시작 전 빠른 점검
mat freshness claude

# 특정 프로필 검사 (JSON 출력, CI 친화)
mat freshness codex --profile work --json

# statusline/dashboard 모드: 같은 보고서를 출력하되 unsafe 상태여도 실패하지 않음
mat freshness --check-only
```

각 source는 4-state로 분류한다 — `fresh`(byte 동일), `rotated`(토큰 회전), `stale`(identity 변경 — 다른 계정, **swap 시 revoke 위험**), `inflight`(multi-source CLI의 부분 갱신 race — 잠시 후 재시도). `rotated`는 adapter가 high/medium confidence로 identity 유지를 확인할 때만 swap 안전이다. fallback byte-diff 결과나 parser 실패는 "바이트가 달라졌다"까지만 말할 수 있으므로, low-confidence `rotated`는 exit-code 기준 unsafe로 취급되어 `--check-only`가 아니면 `1`을 반환한다.

`--check-only`는 read-only 모니터링 모드다. `stale` / low-confidence `rotated` / `inflight` 결과를 그대로 출력하지만 exit code는 `0`으로 유지해 프롬프트, statusline, dashboard가 경고를 표시하면서도 shell 흐름을 끊지 않게 한다. 사용 오류나 source 읽기 실패는 숨기지 않는다.

종료 코드:

| 코드 | 의미 |
| --- | --- |
| `0` | 모든 source가 `fresh` 또는 high-confidence `rotated` — swap 안전 |
| `1` | 하나 이상의 source가 `stale`, low-confidence `rotated`, `inflight` — **swap 전 조치 필요** (`--check-only` 제외) |
| `2` | 사용 오류 |
| `74` | 내부 검사 실패 (source 읽기 에러 등) |

### `mat doctor` — read-only 안전 진단

```bash
mat doctor [--json]
```

알려진 모든 CLI에 대해 metadata-only 안전 진단을 실행한다. `doctor`는 활성 프로필 상태, 저장된 경우 sanitized capture-time identity metadata, 프로필 디렉토리 존재 여부, 비밀값을 읽지 않고 확인 가능한 라이브 source 존재 여부, session 지원 플래그, plugin 경고, provider API-key env var나 project-local config 파일 같은 high-confidence ambient override 채널을 보고한다.

`mat doctor`는 저장본/라이브 자격증명 내용을 비교하지 않고, identity backfill을 위해 profile credential file을 파싱하지 않으며, secret 값을 출력할 수 있는 OS keyring entry 조회도 하지 않는다. OAuth rotation까지 포함한 deep 비교가 필요하면 명시적으로 `mat freshness <cli>`를 사용한다.

```bash
# 사람이 읽는 보고서
mat doctor

# CI/statusline 친화 JSON 보고서
mat doctor --json
```

CLI별 분류 신뢰도는 README 상단 OAuth Rotation 안전성 매트릭스 참고.

### `mat support` / `mat explain` — CLI 지원 경계 설명

```bash
mat support <cli> [--json]
mat explain <cli> [--json]
```

하나의 CLI에 대해 `mat`이 정확히 무엇을 지원하고 왜 그런지 보여준다. 보고서에는 profile swap, freshness/drift 점검, `mat session start`, `mat session run`, source type(라이브 경로나 자격증명 값 제외), capture-time profile identity signal의 static 지원 여부, ambient/project override 위험, 지원 판단의 마지막 upstream 확인 가정이 포함된다.

`explain`은 `support`의 alias다. `agy`처럼 의도적으로 blocked된 CLI도 profile-swap 대상이 아니더라도 설명 가능하다. 사용자 plugin CLI는 profile-swap only + fallback freshness로 표시되며, 신뢰된 session boundary는 없다고 보고한다.

```bash
mat support codex
mat support aider --json
mat explain agy
```

---

## 데이터 저장 위치

```
~/.multi-account-tool/
├── config.json                   # 활성 프로필 포인터 + 플래그
├── app.log                       # best-effort TUI 경고 / 진단 로그
├── audit.jsonl                   # best-effort redacted session lifecycle audit 로그
├── cli-defs/                     # 사용자 플러그인 (선택) — "새 CLI 추가하기" 참고
│   └── <id>.json
├── locks/
│   ├── <cli>.lock/               # CLI별 `mat exec` lock (stale 자동 회수)
│   └── recapture/
│       └── <cli>/<profile>.lock/ # `mat session` 프로필 재캡처 advisory lock
├── sessions/
│   └── <session-id>/             # 실행 중/orphan `mat session` 임시 디렉토리 + session.json
└── profiles/
    ├── claude/                   # credentials.json (macOS Keychain 백업, 평문 JSON)
    │   ├── personal/
    │   │   ├── credentials.json
    │   │   └── meta.json
    │   └── work/...
    ├── codex/                    # auth.json
    ├── gemini/                   # oauth_creds.json + google_accounts.json
    ├── aider/                    # aider.yml
    ├── kimi/                     # config.toml
    ├── qwen/                     # qwen-settings.json + qwen.env (prefix 적용된 saveAs)
    ├── crush/                    # crush-config.json + crush-data.json (config + data 레이어)
    ├── opencode/                 # auth.json (OS 공통 XDG 경로)
    ├── goose/                    # goose-keyring.json (macOS Keychain / Linux Secret Service) + goose-secrets.yaml + goose-config.yaml
    └── grok/                     # grok-auth.json (profile-swap-only ~/.grok/auth.json)
```

파일은 `0600`, 디렉토리는 `0700` 권한으로 생성된다.

---

## 보안

### 수용한 trade-off (의도된 한계)

- **Keychain ACL 호환 모드** — macOS built-in Keychain source는 Claude Code/Goose 같은 upstream CLI가 swap된 항목을 계속 읽을 수 있도록 기본적으로 `security add-generic-password -A`를 유지한다. 이 경우 같은 UID의 프로세스(악의적 `npm postinstall` 등)도 항목을 조용히 읽을 수 있다. 해당 실행에서 no-`-A` 쓰기를 강제하려면 `MAT_KEYCHAIN_RESTRICT_ACL=1`을 설정한다. 사용자/plugin Keychain source가 legacy broad ACL을 필요로 하면 `MAT_KEYCHAIN_ALLOW_ANY_APP=1`로 명시 허용할 수 있다. 더 좁은 `-T <path>` 화이트리스트 모드는 향후 hardening 대상이다.

- **OAuth 토큰 평문 백업** — `~/.multi-account-tool/profiles/` 아래 OAuth 토큰이 평문 JSON으로 저장된다. 파일 `0600`, 디렉토리 `0700` 권한이지만 디스크 백업/스냅샷에는 포함될 수 있다. **Time Machine / iCloud / 클라우드 동기화 폴더에서 제외하길 권장**:

  ```bash
  xattr -w com.apple.metadata:com_apple_backup_excludeItem true ~/.multi-account-tool
  ```

- **명령행 인자 노출** — `security add-generic-password -w <value>`가 평문 토큰을 `argv`로 받는다(`security` CLI 자체 한계). `ps -ef` / BSM audit / EDR 로그에 일시적으로 노출된다. **audit / EDR가 활성화된 기업 환경에서는 사용을 권하지 않는다.**

### 기본 보호 장치

- 모든 외부 명령은 `spawn(argv)`만 사용 — 셸 미경유, injection 차단
- `security`는 절대경로 `/usr/bin/security`만 호출(PATH shim 공격 방지)
- 모든 파일 쓰기는 단일 atomic 헬퍼 (`.tmp → rename`, `O_EXCL + O_NOFOLLOW`, `0600`)
- config 변경은 `mutateConfig` 헬퍼로 직렬화 (in-process race 차단)
- 프로필 이름: `[a-zA-Z0-9가-힣_.-]{1,40}` + NFC 정규화 + `.` / `..` / `/` / `\` / NUL 명시 차단
- Keychain swap: 백업 → 정확 acct 매칭 delete → add. add 실패 시 자동 롤백, 롤백도 실패하면 에러 메시지에 함께 노출.
- multi-source CLI 복원은 부분 실패에 안전 (한 source 실패 시 이미 복원된 source를 라이브 백업으로 되돌림)
- 에러 메시지의 JWT 및 50자+ base64-like 시퀀스는 redact 처리하고, session allow-list 경로는 stderr 노출 전 terminal control char를 sanitize
- 의존성: `npm audit` clean

### 사용을 권하지 않는 환경

- 공용 / 공유 워크스테이션
- 다중 사용자 호스트
- 관리형 / audit·EDR 활성 기업 기기
- 클라우드 동기화 폴더 안의 home 디렉토리

---

## 새 CLI 추가하기

두 가지 방법.

### 1. 사용자 플러그인 — 코드 변경 불필요 (개인 사용 권장)

`~/.multi-account-tool/cli-defs/<id>.json` 파일을 만든다. 임의 CLI 추가용 템플릿 예:

```json
{
  "id": "my-cli",
  "name": "My CLI",
  "sources": [
    { "type": "file", "path": "~/.config/my-cli/credentials.json", "saveAs": "credentials.json" }
  ]
}
```

파일을 직접 쓰지 않고 starter JSON을 만들 수도 있다:

```bash
mkdir -p ~/.multi-account-tool/cli-defs
mat plugin scaffold my-cli > ~/.multi-account-tool/cli-defs/my-cli.json
mat plugin validate ~/.multi-account-tool/cli-defs/my-cli.json
mat plugin validate --json   # 설치된 ~/.multi-account-tool/cli-defs/*.json 전체 검증
```

`mat plugin validate`는 **정적** JSON/schema/lint 검사다. credential 파일을 읽거나 Keychain/Secret Service secret 값을 조회하지 않고, upstream CLI가 의도한 credential source를 우선 사용할지 증명하지도 않는다. 통과했다는 뜻은 **정적 검증 통과**이지 security-certified라는 의미가 아니다. JSON report는 `schemaVersion: 1`이며 exit code는 error 없음 `0`, validation/read/parse error `1`, 사용법 오류 `2`다. 너무 넓은 file path나 `account` 없는 generic keychain service 같은 위험하지만 호환되는 패턴은 warning으로 보고한다.

`mat`은 시작 시 해당 디렉토리의 모든 `*.json`을 로드한다. 잘못된 plugin은 경고 후 skip되며, `mat` 본체는 정상 동작한다. 빌트인 CLI(`claude`, `codex`, `gemini`, `aider`, `kimi`, `qwen`, `crush`, `opencode`, `goose`, `grok`) id와 충돌하면 plugin이 무시된다(보안).

필드 규칙:
- `id`: 영문 시작 + 영숫자/`_`/`-`, 1~32자(빌트인 id와 중복 불가).
- `name`: 비어있지 않은 임의 문자열 (표시용).
- `sources[].type`: `'file'`, `'keychain'`(macOS Keychain), `'os-keyring'`(Linux Secret Service), `'env-secret'`(metadata-only; product runtime blocked), `'win-credential'`(Windows Credential Manager generic credential primitive).
- `sources[].saveAs`: ASCII 파일명, 1~64자 (`[a-zA-Z0-9._-]`).
- `sources[].path`(file): 비어있지 않은 문자열(`~/` 자동 확장).
- `sources[].service`(keychain/os-keyring): 비어있지 않은 credential service 이름.
- `sources[].account`(keychain/os-keyring, **선택**): service+account 항목 하나로 `mat`의 조작 scope를 제한. **generic / multi-account service**에 필수(예: Goose의 `goose`/`secrets`, 동일 service의 여러 entry를 가진 CLI) — 미지정 시 `mat`이 잘못된 account를 잡을 위험이 있다. 검증: 비어있지 않은 문자열, 제어문자 차단. 단일-account service는 생략 가능(기존 동작 유지).
- `sources[].backend`(os-keyring, 선택): `'auto'` 또는 `'secret-service'`.
- `sources[]`의 `type: 'win-credential'`: 정확한 key만 허용 — `type`, `targetName`, `credentialType: 'generic'`, 필수 `account`, 필수 `persist`(`'session' | 'local-machine' | 'enterprise'`), `saveAs`. Windows lookup identity는 `targetName + credentialType`이며, `account`는 lookup selector가 아니라 필수 UserName metadata guard다. 비-Windows host에서는 detector/freshness/doctor/support가 이 source를 일반 missing이 아닌 unsupported/blocked로 보고한다. 이는 package-level Windows support, built-in Windows CLI support, Copilot support, 또는 신뢰된 `mat session` 경계를 의미하지 않는다.

Plugin은 **profile-swap 정의 전용**이다. `session`, `sessionRun`, env policy, ambient credential scrub 규칙, project override hard-stop을 정의할 수 없고, 사용자 plugin CLI는 신뢰된 `mat session start/run` 경계가 아니다.

### 2. 빌트인 추가 — mat repo PR 필요

`src/core/cli-defs.ts`에 항목 추가:

```ts
{
  id: 'foo',
  name: 'Foo CLI',
  sources: [
    { type: 'file', path: '~/.foo/credentials.json', saveAs: 'credentials.json' }
  ]
}
```

`mat`과 함께 배포되어야 할 커뮤니티 CLI용. PR 환영.

---

## 변경 이력

릴리스 이력과 주요 변경 사항은 [CHANGELOG.md](./CHANGELOG.md) 참고 (Keep a Changelog 형식, Semantic Versioning).

## 로드맵

v0.4+ 계획은 [ROADMAP.md](./ROADMAP.md) 참고:

- ~~커뮤니티 CLI 정의를 위한 플러그인 메커니즘~~ ✅ (v0.3)
- ~~Aider 빌트인 지원~~ ✅ (v0.3) + ~~Kimi / Qwen / Crush / OpenCode~~ ✅ (v0.3.x)
- ~~세션별 자격증명 격리~~ ✅ (v0.4.x — `mat session start/list/stop`: env 주입 + copy-isolate, 동시 다계정; `@ictechgy/lterm` v1.0.25+에서 `lterm` profile shim 통합 완료)
- ~~`mat session run <cli> <profile> -- [cli-args...]` framework~~ ✅ — command-scoped safer-run 기반. ~~OpenCode hard-stop probe~~ ✅; ~~Aider forced config/env-file partial-run~~ ✅. ~~Antigravity auth-store research artifact~~ ✅, 하지만 제품 지원은 upstream이 안정 auth-store, redirect, recapture 계약을 문서화할 때까지 blocked로 유지한다. [Antigravity research note](./docs/superpowers/specs/2026-06-14-antigravity-auth-store-research.md)와 [session-run R&D note](./docs/superpowers/specs/2026-06-12-command-scoped-session-run-rd.md) 참고.
- 빌트인 CLI 추가 확장 — ~~Goose~~ ✅ (v0.4.0 account-scoped Keychain; Linux Secret Service는 `os-keyring` source type으로 추가됨). Copilot / Amp는 보류 — [Copilot/Amp research note](./docs/superpowers/specs/2026-06-14-copilot-amp-auth-research.md) 참고. Copilot은 명시적 account binding, application-state swap, ambient token fallback 정책, Windows Credential Manager 지원이 필요하다. Amp는 일반 file/keychain profile swap이 아니라 env-secret / command-scoped 실행 설계가 필요하다. Cursor Agent는 plugin 권장(keychain service name 공식 미공개).
- **Goose Linux**: Linux에서 `mat`은 Goose의 기본 `secret-service` 백엔드(libsecret, GNOME Keyring/KWallet)를 `os-keyring` source(`secret-tool` CLI, `goose`/`secrets`)로 swap하고 `~/.config/goose/*.yaml`도 함께 swap한다. 설정별 동작:
  - **기본(keyring)**: os-keyring source가 포함되며 `secret-tool`(libsecret-tools) + keyring daemon이 필요하다. 미설치이거나 daemon이 down/접근거부면 **명시 에러** — yaml로 조용히 fallback 하지 *않는다*. Goose는 keyring에 libsecret *라이브러리*(`secret-tool` CLI와 별도 패키지)로 접근하므로, CLI 부재가 keyring 미사용을 증명하지 못한다. 활성 keyring 사용자에게 `secrets.yaml`을 조용히 swap하면 wrong-account가 된다. (도구 부재가 아니라) keyring 항목 자체의 부재는 정상 "not found"로 yaml로 넘어간다.
  - **file backend**: `GOOSE_DISABLE_KEYRING` 설정. `mat`은 이 env가 **존재하면**(값 무관 — `0`/`false`/빈 문자열 포함) file backend로 본다 — Goose 자신의 `env::var(...).is_ok()` 판정과 동일. 그러면 keyring source(Linux=os-keyring, macOS=Keychain)를 **생략**하고 `secrets.yaml` + `config.yaml`만 swap한다. `config.yaml`만의 `keyring: false` 설정은 자동 감지하지 않으니 env도 함께 지정하라.
- ~~`lterm claude --profile <name>` 같은 shim wrapper~~ ✅ (`ictechgy/light_terminal` PR #144에서 구현)

---

## 라이선스

MIT — [LICENSE](./LICENSE)
