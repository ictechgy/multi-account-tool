# multi-account-tool (`mat`)

[English](README.md) | 한국어

여러 AI CLI 계정(Claude Code, Codex, Gemini / Antigravity, Aider, Kimi, Qwen, Crush, OpenCode, Goose)을 **하나의 TUI 에서 빠르게 전환**해 사용하는 도구. 매번 `logout` → `login` 반복할 필요 없이 계정마다 프로필 하나씩 두고 단축키로 바꿔 끼울 수 있다. macOS Keychain 백업 자동 롤백, atomic 파일 쓰기, 평문 백업 위치 명시, OAuth refresh 토큰 회전 인지 + TUI 재캡처/폐기/취소 dialog 등 안전장치를 기본 적용.

```
╭ Multi-Account Tool ────────────────────────────────╮
│  AI CLI 계정 스위처                                 │
╰─────────────────────────────────────────────────────╯

  > Claude Code            [활성: personal] ✓
    Codex CLI              [활성: work]     ✓
    Gemini / Antigravity   [활성: personal] ✓
```

---

## 왜 만들었나

- Claude Code, Codex, Gemini 등 여러 AI CLI 를 동시에 쓰면서 각 CLI 마다 계정이 여러 개일 때
- 매번 `logout` / `login` 반복이 귀찮을 때
- "지금 어느 계정으로 로그인돼 있더라?" 헷갈릴 때

## 어떻게 동작하나

`mat` 은 각 CLI 의 **자격증명만 정밀하게 swap** 한다. hooks, agents, `CLAUDE.md`, 대화 이력, 설정 같은 나머지는 그대로 둔다.

| CLI | 자격증명 위치 | 보관 방식 |
| --- | --- | --- |
| Claude Code | macOS Keychain (`Claude Code-credentials`) | Keychain 항목 swap |
| Codex CLI | `~/.codex/auth.json` | 파일 swap |
| Gemini / Antigravity | `~/.gemini/oauth_creds.json`, `google_accounts.json` | 파일 swap |
| Aider | `~/.aider.conf.yml` | 파일 swap |
| Kimi CLI | `~/.kimi/config.toml` | 파일 swap |
| Qwen Code CLI | `~/.qwen/settings.json`, `~/.qwen/.env` | 파일 swap |
| Crush | `~/.config/crush/crush.json`, `~/.local/share/crush/crush.json` | 파일 swap |
| OpenCode | `~/.local/share/opencode/auth.json` (OS 공통, XDG 표준) | 파일 swap |
| Goose | macOS Keychain (service `goose`, account `secrets`) + `~/.config/goose/secrets.yaml` + `config.yaml` | Multi-source (account scoped Keychain; Linux 는 `GOOSE_DISABLE_KEYRING=1` 필요 — 아래 참고) |

### OAuth Rotation 안전성 매트릭스

일부 CLI 는 **OAuth refresh token rotation** (RFC 6749 권장 보안 정책) 을 사용한다 — refresh token 은 한 번 사용되면 invalidate 되어 같은 token 을 다시 쓸 수 없다. `mat` 이 옛 token 스냅샷을 복원하면 provider 가 "이미 사용된 token" 으로 거부 (`refresh_token_reused` 401) → 사용자가 강제 재로그인해야 한다. 본 매트릭스는 mat 지원 CLI 중 영향 받는 도구와 mat 의 안전 모드를 정리한다.

| CLI | 인증 방식 | rotation 위험 | mat 안전 모드 |
| --- | --- | --- | --- |
| Codex CLI | OAuth (`tokens.refresh_token`, `tokens.account_id`) | 🔴 높음 — token revoke 재현됨 | swap 전 `mat freshness codex` 점검 / 일회성은 `mat exec` |
| Gemini / Antigravity | OAuth (`refresh_token` + `google_accounts.json.active`) | 🔴 높음 | Codex 와 동일 |
| OpenCode | provider 별 OAuth (`provider.refresh`, `provider.accountId`) | 🔴 높음 | Codex 와 동일 |
| Claude Code | macOS Keychain (Anthropic OAuth) | 🟢 완화됨 — identity-aware adapter (`subscriptionType` + macOS keychain account) | `mat exec` 또는 `mat freshness claude` (PR-H adapter, high-confidence rotation 분류) |
| Goose | macOS Keychain + `secrets.yaml` / `config.yaml` (provider 라우팅) | 🟢 완화됨 — identity-aware adapter (provider key 매트릭스 + keychain account) | `mat freshness goose` 가 source 별 결과 보고, identity-aware |
| Aider / Kimi / Qwen / Crush | 정적 API key | 🟢 없음 | 일반 swap 으로 충분 — 단 환경변수 / project-local 설정이 mat 의 swap 을 우회할 수 있음 (아래 "플랫폼 지원" 참고) |

`mat freshness [<cli>] [--profile <name>] [--json]` 명령으로 swap 전 라이브와 활성 프로필의 자격증명을 비교한다. exit code 0 = 안전, exit code 1 = `stale` 감지 (identity 변경 또는 프로필 부재). 장기 실행 세션은 `mat exec` 사용을 권장 — 명령 종료 후 자동으로 이전 프로필 복원. 단 mat 자체가 `SIGKILL` 을 받으면 복원이 일어나지 않는다 (보안 섹션 참조).

> **OAuth rotation 대응 (PR-G/PR-I\*/PR-H 모두 머지):** TUI 의 swap 흐름이 swap 직전 라이브 freshness 를 점검하고 차이 감지 시 **재캡처 / 폐기 / 취소** 3-옵션 dialog 를 표시한다 (PR-G). 재캡처는 라이브를 `snapshotLiveToProfile` 로 활성 프로필에 저장 후 swap, 폐기는 자동 snapshot 을 건너뛰고 swap (데이터 손실), 취소는 swap 미실행. `mat exec` 는 종료 시 라이브를 swap-target 프로필로 재캡처한 뒤 원래 활성 프로필로 복원 (PR-I\*) — `SIGINT`/`SIGTERM`/`SIGHUP` 까지 보호 (`SIGKILL` 은 OS 보장상 trap 불가 → 다음 `mat` 호출의 stale-recovery 가 사용자에게 안내). Claude/Goose identity-aware adapter (PR-H) 가 `high`/`medium` confidence 로 rotation vs 다른 계정을 분류 — 안전한 swap 에서 `[low conf]` dialog noise 제거.

### 플랫폼 지원

| CLI | macOS | Linux | Windows | Override / 알려진 한계 |
| --- | --- | --- | --- | --- |
| Claude Code | ✅ | ❌ | ❌ | macOS Keychain 전용 — Linux/Windows credential-store 백엔드 미지원 |
| Codex CLI | ✅ | ✅ | ⚠️ 미검증 | `~/.codex/auth.json` (cross-platform file path) |
| Gemini / Antigravity | ✅ | ✅ | ⚠️ 미검증 | `~/.gemini/oauth_creds.json` + `google_accounts.json` |
| Aider | ✅ | ✅ | ⚠️ 미검증 | **env override**: `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENAI_API_BASE` 등이 `~/.aider.conf.yml` 을 우회 — mat 는 shell env 를 swap 할 수 없음 |
| Kimi CLI | ✅ | ✅ | ⚠️ 미검증 | **env override**: `MOONSHOT_API_KEY` 등이 `~/.kimi/config.toml` 을 우회 |
| Qwen Code CLI | ✅ | ✅ | ⚠️ 미검증 | 자격증명 우선순위: **shell env > `~/.qwen/.env` > `~/.qwen/settings.json`**. mat 는 두 파일 모두 swap 하지만 shell env 는 영향 없음 |
| Crush | ✅ | ✅ | ⚠️ 미검증 | **project-local override**: CWD 의 `./.crush.json` / `./crush.json` 이 `~/.config/crush/*` 보다 우선; `CRUSH_GLOBAL_*` env 도 우선 |
| OpenCode | ✅ | ✅ | ⚠️ 미검증 | OS 공통 XDG 경로 (`~/.local/share/opencode/auth.json`, 모든 OS 에서 `xdg-basedir` 사용) |
| Goose | ✅ | ⚠️ file-only | ❌ | macOS Keychain (`goose`/`secrets`) + `~/.config/goose/*.yaml`. Linux 는 `GOOSE_DISABLE_KEYRING=1` (또는 `config.yaml` 의 file backend) 필요 — mat 가 `secret-service`/libsecret 아직 미지원 |

"⚠️ 미검증" = swap 로직은 platform-agnostic file I/O 라 동작 가능성 있지만 본 프로젝트 CI 는 macOS + Ubuntu 만 검증. Windows 경로는 각 CLI 의 공식 문서 기반 추정 — 실제 실행은 안 됨. patch / 버그 리포트 환영.

### 전환 흐름 (데이터 손실 없음)

0. **swap 전 freshness 점검** — 라이브 자격증명이 활성 프로필 저장본과 drift (OAuth refresh 토큰 회전 등) 가 감지되면, 아래 1~3 단계 전에 **재캡처 / 폐기 / 취소** dialog 가 먼저 표시된다. CLI 별 분류 신뢰도는 위의 "OAuth Rotation 안전성 매트릭스" 참고.
1. 현재 라이브 자격증명을 **현재 활성 프로필**에 자동 스냅샷
2. 선택한 프로필의 저장된 자격증명을 라이브 위치로 **원자적으로 복원**
3. 활성 프로필 포인터 업데이트

multi-source CLI (예: Gemini 의 두 파일) 의 경우 **부분 실패 롤백**도 적용된다 — 한 source 복원에 실패하면 이미 복원된 source 를 라이브 백업으로 되돌려 라이브가 절반만 새 프로필인 상태를 막는다.

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
mat --help                     # subcommand 목록 (TUI 옵션 + `mat exec` / `mat freshness`)
node scripts/smoke-test.mjs    # 소스 체크아웃 전용 — read-only smoke test (CLI 정의 로드 + path resolve 확인, 자격증명 미수정)
```

smoke test 는 read-only 라 활성 mat 프로필이 있는 환경에서도 안전하다.

---

## 사용

```bash
mat              # TUI 실행
mat --version    # 설치된 버전 출력
mat --help       # 짧은 사용법 (subcommand: exec / freshness)
```

TUI 가 열리면 **CLI 선택 → 프로필 선택 → 전환**.

### 첫 실행

이미 로그인된 자격증명이 감지되면 `default` 프로필로 가져올지 묻는다. 한 번 답하면 다음 실행부터 자동으로 다시 묻지 않는다 (수동 캡처는 언제나 가능).

### 새 계정 추가하기

1. `mat` → CLI 선택 → `a` (새 프로필) → 이름 입력 (예: `work`)
2. 새 프로필 위에서 `Enter` 눌러 활성화. 만약 라이브 자격증명이 **활성 프로필**의 저장본과 drift (OAuth refresh 토큰 회전 등) 한 상태면 swap 직전에 **재캡처 / 폐기 / 취소** dialog 가 표시된다 — 위의 전환 흐름 + OAuth Rotation 안전성 매트릭스 참고.
3. 별도 터미널에서 해당 CLI 의 로그인 명령 실행 (`claude`, `codex`, `gemini` 등). 라이브 자격증명이 새 계정 것으로 덮어쓰인다.
4. `mat` 으로 돌아와 같은 프로필 위에서 `c` (캡처) → 새 라이브 자격증명이 프로필에 저장됨
5. 이후로는 `Enter` 만으로 프로필 사이를 자유롭게 전환

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

`<profile>` 로 일시 swap → `<cmd>` 실행 → 명령 종료 시 원래 활성 프로필로 자동 원복.

```bash
# 한 번의 Claude 세션만 work 프로필로 실행, 종료 후 personal 로 원복
mat exec claude work -- claude

# lterm 과 조합 (선택 — `npm install -g @ictechgy/lterm` 으로 별도 설치 필요)
lterm send-keys "mat exec claude work -- claude" Enter
```

동작:

- `<cli>` 에 이미 활성 프로필이 설정되어 있어야 한다 (먼저 TUI 로 라이브 자격증명을 캡처).
- CLI 별 lockfile (`~/.multi-account-tool/locks/<cli>.lock`) 로 동일 CLI 의 `mat exec` 가 동시에 race 하지 않도록 직렬화. 비정상 종료로 남은 stale lock 은 자동 복구.
- 자식에 `SIGINT` / `SIGTERM` / `SIGHUP` 을 전달하고, 자식의 종료 코드/시그널을 그대로 반영한다.
- **종료 시 라이브 자격증명을 `<profile>` 으로 재캡처한 뒤 원래 활성 프로필로 원복**한다 (`<cmd>` 가 OAuth refresh rotation 등으로 토큰을 갱신했을 가능성 보존). 재캡처는 기본 10s timeout (`MAT_EXEC_RECAPTURE_TIMEOUT_MS` env override) 으로 keychain prompt hang 차단.
- 원복은 `finally` 블록에서 일어나 정상 종료, 에러, trap 가능 시그널 모두에서 실행된다. **단 `mat` 자체가 `SIGKILL` (또는 `SIGSEGV` / `SIGBUS` 등 trap 불가 시그널) 을 받으면 원복은 일어나지 않는다** — 다음 `mat` 실행 시 stale lock 자동 회수 + 사용자에게 "라이브 자격증명이 이전 활성 프로필이 아닌 `<profile>` 의 것일 수 있음" stderr 안내 (정책 B: warn + drop).

이는 **시간 격리**이지 세션 격리가 아니다. 자식이 실행되는 동안 OS 전역 자격증명은 `<profile>` 의 것. 두 터미널에서 서로 다른 `mat exec` 를 동시에 띄우면 lock 으로 직렬화되며, 진짜 세션별 격리는 로드맵.

종료 코드:

| 코드 | 의미 |
| --- | --- |
| `0` | 자식 정상 종료 0 (원복 성공) |
| `2` | 사용 오류 (`UsageError` — spawn 전 검증 실패) |
| `74` | `mat` 자체의 원복 실패 (`restoreError`) — 자식 결과는 stdout/stderr 로 출력됨 |
| `75` | 다른 `mat exec` 가 CLI lock 보유 중 (`LockHeldError` — spawn 전) |
| `128+N` | 자식이 시그널 `N` 으로 종료 (예: SIGINT 면 `130`) |
| `1` | 자식이 종료 코드 `1` 로 끝났거나, `mat` 자체가 spawn 전후로 예상치 못한 에러 |
| _그 외 (예: `3`, `42`)_ | 자식의 non-zero 종료 코드를 그대로 propagate |

참고: `2` / `74` / `75` 는 `mat` 자체의 에러 모델로 예약 (spawn 전 검증 / lock 경합 / spawn 후 원복 실패). 그 외의 `128` 미만 non-zero 코드는 모두 자식의 종료 코드를 투명하게 그대로 전달. `74` 가 `mat` 의 원복 실패인지 자식의 exit 74 인지 헷갈리면 stderr 의 `restoreError` 로그를 확인.

### `mat freshness` — swap 전 안전성 점검

```bash
mat freshness [<cli>] [--profile <name>] [--json]
```

라이브 자격증명과 활성 (또는 지정) 프로필 저장본을 비교해 swap 전에 drift 를 보고. CI chain (`mat freshness && deploy.sh`) 으로 wrong-profile 복원으로 인한 OAuth `refresh_token` revoke 사고 사전 차단.

```bash
# 긴 Claude 세션 시작 전 빠른 점검
mat freshness claude

# 특정 프로필 검사 (JSON 출력, CI 친화)
mat freshness codex --profile work --json
```

각 source 는 4-state 로 분류 — `fresh` (byte 동일), `rotated` (토큰 회전됐지만 identity 유지, swap 안전), `stale` (identity 변경 — 다른 계정, **swap 시 revoke 위험**), `inflight` (multi-source CLI 의 부분 갱신 race — 잠시 후 재시도).

종료 코드:

| 코드 | 의미 |
| --- | --- |
| `0` | 모든 source 가 `fresh` 또는 high-confidence `rotated` — swap 안전 |
| `1` | 하나 이상의 source 가 `stale`, low-confidence `rotated`, `inflight` — **swap 전 조치 필요** |
| `2` | 사용 오류 |
| `74` | 내부 검사 실패 (source 읽기 에러 등) |

CLI 별 분류 신뢰도는 README 상단 OAuth Rotation 안전성 매트릭스 참고.

---

## 데이터 저장 위치

```
~/.multi-account-tool/
├── config.json                   # 활성 프로필 포인터 + 플래그
├── cli-defs/                     # 사용자 플러그인 (선택) — "새 CLI 추가하기" 참고
│   └── <id>.json
├── locks/                        # CLI 별 `mat exec` lock (stale 자동 회수)
│   └── <cli>.lock/
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
    └── goose/                    # goose-keyring.json (macOS) + goose-secrets.yaml + goose-config.yaml
```

파일은 `0600`, 디렉토리는 `0700` 권한으로 생성된다.

---

## 보안

### 수용한 trade-off (의도된 한계)

- **Keychain ACL 완화** — Keychain 기반 source (Claude Code credentials / Goose `goose`/`secrets` entry 등) 는 보통 특정 바이너리만 접근하도록 Keychain ACL 이 걸려 있다. `mat` 은 swap 시 `security add-generic-password -A` 로 항목을 다시 만들어 같은 사용자의 모든 프로세스가 접근할 수 있게 한다 — 안 그러면 swap 후 upstream CLI 가 자기 토큰을 읽지 못한다. 같은 UID 의 프로세스 (악의적 `npm postinstall` 등) 도 토큰을 읽을 수 있게 되는 점은 알고 있어야 한다. 추후 릴리스에서 opt-in restrictive 모드 (`-T` 화이트리스트) 도입 예정.

- **OAuth 토큰 평문 백업** — `~/.multi-account-tool/profiles/` 아래 OAuth 토큰이 평문 JSON 으로 저장된다. 파일 `0600`, 디렉토리 `0700` 권한이지만 디스크 백업/스냅샷에는 포함될 수 있다. **Time Machine / iCloud / 클라우드 동기화 폴더에서 제외하길 권장**:

  ```bash
  xattr -w com.apple.metadata:com_apple_backup_excludeItem true ~/.multi-account-tool
  ```

- **명령행 인자 노출** — `security add-generic-password -w <value>` 가 평문 토큰을 `argv` 로 받는다 (`security` CLI 자체 한계). `ps -ef` / BSM audit / EDR 로그에 일시적으로 노출된다. **audit / EDR 가 활성화된 기업 환경에서는 사용을 권하지 않는다.**

### 기본 보호 장치

- 모든 외부 명령은 `spawn(argv)` 만 사용 — 셸 미경유, injection 차단
- `security` 는 절대경로 `/usr/bin/security` 만 호출 (PATH shim 공격 방지)
- 모든 파일 쓰기는 단일 atomic 헬퍼 (`.tmp → rename`, `O_EXCL + O_NOFOLLOW`, `0600`)
- config 변경은 `mutateConfig` 헬퍼로 직렬화 (in-process race 차단)
- 프로필 이름: `[a-zA-Z0-9가-힣_.-]{1,40}` + NFC 정규화 + `.` / `..` / `/` / `\` / NUL 명시 차단
- Keychain swap: 백업 → 정확 acct 매칭 delete → add. add 실패 시 자동 롤백, 롤백도 실패하면 에러 메시지에 함께 노출.
- multi-source CLI 복원은 부분 실패에 안전 (한 source 실패 시 이미 복원된 source 를 라이브 백업으로 되돌림)
- 에러 메시지의 JWT 및 50자+ base64-like 시퀀스는 redact 처리
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

mat 은 시작 시 해당 디렉토리의 모든 `*.json` 을 로드한다. 잘못된 plugin 은 경고 후 skip — mat 본체는 정상 동작. 빌트인 CLI (`claude`, `codex`, `gemini`, `aider`, `kimi`, `qwen`, `crush`, `opencode`, `goose`) id 와 충돌하면 plugin 이 무시된다 (보안).

필드 규칙:
- `id`: 영문 시작 + 영숫자/`_`/`-`, 1~32자 (빌트인 id 와 중복 불가).
- `name`: 비어있지 않은 임의 문자열 (표시용).
- `sources[].type`: `'file'` 또는 `'keychain'` (keychain 은 macOS 전용).
- `sources[].saveAs`: ASCII 파일명, 1~64자 (`[a-zA-Z0-9._-]`).
- `sources[].path` (file): 비어있지 않은 문자열 (`~/` 자동 확장).
- `sources[].service` (keychain): 비어있지 않은 Keychain service 이름.
- `sources[].account` (keychain, **선택**): `-s <service> -a <account>` 항목 하나로 `mat` 의 keychain 조작 scope 를 제한. **generic / multi-account service** 에 필수 (예: Goose 의 `goose`/`secrets`, 동일 service 의 여러 entry 가진 CLI) — 미지정 시 `mat` 이 잘못된 account 잡을 위험. 검증: 비어있지 않은 문자열, NUL 차단. 단일-account service 는 생략 가능 (기존 동작 유지).

### 2. 빌트인 추가 — mat repo PR 필요

`src/core/cli-defs.ts` 에 항목 추가:

```ts
{
  id: 'foo',
  name: 'Foo CLI',
  sources: [
    { type: 'file', path: '~/.foo/credentials.json', saveAs: 'credentials.json' }
  ]
}
```

mat 과 함께 배포되어야 할 커뮤니티 CLI 용. PR 환영.

---

## 변경 이력

릴리스 이력과 주요 변경 사항은 [CHANGELOG.md](./CHANGELOG.md) 참고 (Keep a Changelog 형식, Semantic Versioning).

## 로드맵

v0.4+ 계획은 [ROADMAP.md](./ROADMAP.md) 참고:

- ~~커뮤니티 CLI 정의를 위한 플러그인 메커니즘~~ ✅ (v0.3)
- ~~Aider 빌트인 지원~~ ✅ (v0.3) + ~~Kimi / Qwen / Crush / OpenCode~~ ✅ (v0.3.x)
- 세션별 자격증명 격리 (`lterm` 세션마다 다른 계정)
- 빌트인 CLI 추가 확장 — ~~Goose~~ ✅ (v0.4.0, account-scoped Keychain). Copilot / Amp 는 mat 추상화 추가 확장 (Linux Secret Service / Windows Credential Manager source type) 후 별도 PR 묶음 예정. Cursor Agent 는 plugin 권장 (keychain service name 공식 미공개).
- **Goose 한계**: mat 는 macOS Keychain (`goose`/`secrets`) 과 `~/.config/goose/*.yaml` 만 swap. Linux 에서 Goose 가 기본 `secret-service` 백엔드 (libsecret, GNOME Keyring/KWallet) 를 쓰면 mat 가 접근할 수 없으므로, Goose 의 keyring 을 끄고 (`GOOSE_DISABLE_KEYRING=1` 또는 `~/.config/goose/config.yaml` 의 file backend 설정) credentials 가 `secrets.yaml` 에 저장되도록 해야 한다.
- `lterm claude --profile <name>` 같은 shim wrapper

---

## 라이센스

MIT — [LICENSE](./LICENSE)
