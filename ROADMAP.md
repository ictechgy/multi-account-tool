# mat — Roadmap (v0.2+)

> v0.1.0 이후 합의된 향후 작업. 새 세션/PR 이 이어받을 수 있도록 컨텍스트와 결정 포인트를 정리한다.
> 각 항목은 별도 commit/PR 단위. 우선순위는 마지막 섹션 참고.

---

## Done

- ✅ **`mat exec <cli> <profile> -- <cmd...>`** — 시간 격리 실행. cli 별 lockfile 로 동시 swap 차단, stale lock 자동 복구, SIGINT/SIGTERM/SIGHUP 전달, `finally` 원복. 세션 격리는 아니며 `SIGKILL` 시 원복 불가는 한계로 명시.

---

## 1. 다른 AI CLI 도구 스왑 지원

### 현재 (v0.3) 내장 CLI

| id | credential 위치 |
| --- | --- |
| `claude` | macOS Keychain (`Claude Code-credentials`) |
| `codex` | `~/.codex/auth.json` |
| `gemini` | `~/.gemini/oauth_creds.json` + `google_accounts.json` |
| `aider` | `~/.aider.conf.yml` |
| `kimi` | `~/.kimi/config.toml` |
| `qwen` | `~/.qwen/settings.json` + `~/.qwen/.env` |
| `crush` | `~/.config/crush/crush.json` + `~/.local/share/crush/crush.json` |
| `opencode` | macOS: `~/Library/Application Support/opencode/auth.json` / Linux: `~/.local/share/opencode/auth.json` |

### 확장 대상 universe

`lterm` README 가 정리한 agent 리스트와 같은 부분 채택:

- **즉시 가능 (file-based)**: ~~Aider~~ ✅ (v0.3 빌트인), ~~Kimi~~ ✅ (v0.3.x 빌트인), ~~Qwen~~ ✅ (v0.3.x 빌트인), ~~Crush~~ ✅ (v0.3.x 빌트인), ~~OpenCode~~ ✅ (v0.3.x 빌트인), Goose, Amp
- **GitHub Copilot CLI** — GitHub 토큰 (`~/.config/gh/` 또는 own store)
- **Cursor Agent** — `~/Library/Application Support/Cursor/` (큰 디렉토리, 일부만 swap)
- **Kiro, Jules** — credential 패턴 미조사

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
- **Aider**: `--config-file <path>` CLI 옵션 + `OPENAI_API_KEY` env 직접 export

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
- `@ictechgy/lterm` v1.0.3 (사용자 본인 작품, npm: `@ictechgy/lterm`)
- tmux 호환 PTY 세션 데몬 (`lterm start`, `lterm resume`, `lterm send-keys`)
- 빌트인 agent shim: `lterm claude` / `lterm codex` / `lterm agy` / `lterm gemini` 등

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

#### B. lterm session hook (있다면)
- 세션 시작/종료 hook API 가 있는지 확인
- 있으면: 세션 이름 → mat profile 자동 매핑
- 없으면: shim wrapper 만으로 진행 (lterm 코드 변경 불필요)

#### C. lterm `claude` shim 확장
- `lterm claude --profile <name>` 옵션
- 내부에서 mat exec 호출 후 claude 실행
- lterm 측 변경 필요 (`@ictechgy/lterm` repo 와 협력)

### 결정 포인트
- lterm hook API 의존 vs shim wrapper 만으로 → 후자가 의존성 작음
- 시간 격리 (A) 만 vs 세션 격리 (B+#2 결합) → 후자는 #2 의 unknown 해결 선행 필요

---

## 결정 필요 항목 (조사/논의 후 확정)

- [ ] 각 추가 CLI 의 credential 위치/포맷 (조사 필요)
- [ ] credential override env var 지원 여부 (CLI 별)
- [ ] plugin/extension 메커니즘: JSON config vs JS module
- [ ] lterm hook API 의존 vs shim wrapper 만으로 진행
- [ ] `mat exec <profile> -- <cmd>` 인터페이스 (subprocess env 격리 한계)
- [ ] session 디렉토리 누수 정리 정책 (orphan TTL?)

---

## 제안 우선순위

| 순서 | 작업 | 사유 |
| --- | --- | --- |
| 1 | ~~`~/.multi-account-tool/cli-defs/*.json` plugin~~ ✅ | 사용자가 mat 코드 변경 없이 새 CLI 추가 (PR #14) |
| 2 | ~~Aider 내장 지원~~ ✅ | text-based config 라 가장 단순 (v0.3 빌트인) |
| 3 | 다른 CLI 조사 + 내장 추가 | Cursor / Goose / Copilot 등 |
| 4 | 세션 격리 (#2) | env var override 지원 CLI 부터. Keychain CLI 는 별도 R&D |
| 5 | lterm shim wrapper (`lterm claude --profile X`) | lterm repo 협력 |

---

## v0.1 에서 의도적으로 처리 안 한 항목 (재방문 가치)

quad-review (2026-05-23) 에서 수용된 trade-off:

- **`security` CLI `-w <value>` argv 노출** — argv 가 `ps -ef`/audit 로그에 노출. CLI 자체 한계. native Keychain API binding (Rust/Swift) 로 대체 시 해결 가능하나 큰 변경.
- **`-A` ACL 완화** — Claude 가 자기 토큰 못 읽는 회귀 회피용. opt-in `-T <path>` whitelist 모드로 v0.2 검토.
- **평문 backup** — `~/.multi-account-tool/profiles/` 의 자격증명이 평문 JSON. native Keychain 으로만 보관하거나 (위와 동일 dependency) age/passphrase 기반 암호화 옵션.
- **용어 일관성** — snapshot (내부 API) / 캡처 (UI 액션) / 백업 (switch 부수효과) / 가져오기 (초기 import) 가 의도된 차별화. UI 사용자 피드백 받으면 통일 검토.
