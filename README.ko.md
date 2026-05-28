# multi-account-tool (`mat`)

[English](README.md) | 한국어

여러 AI CLI 계정(Claude Code, Codex, Gemini / Antigravity, Aider, Kimi, Qwen, Crush, OpenCode)을 **하나의 TUI 에서 빠르게 전환**해 사용하는 도구. 매번 `logout` → `login` 반복할 필요 없이 계정마다 프로필 하나씩 두고 단축키로 바꿔 끼울 수 있다. macOS Keychain 백업 자동 롤백, atomic 파일 쓰기, 평문 백업 위치 명시 등 안전장치를 기본 적용.

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

### 전환 흐름 (데이터 손실 없음)

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

---

## 사용

```bash
mat
```

TUI 가 열리면 **CLI 선택 → 프로필 선택 → 전환**.

### 첫 실행

이미 로그인된 자격증명이 감지되면 `default` 프로필로 가져올지 묻는다. 한 번 답하면 다음 실행부터 자동으로 다시 묻지 않는다 (수동 캡처는 언제나 가능).

### 새 계정 추가하기

1. `mat` → CLI 선택 → `a` (새 프로필) → 이름 입력 (예: `work`)
2. 새 프로필 위에서 `Enter` 눌러 활성화
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

### `mat exec` — 한 명령에 한해 프로필 swap

```bash
mat exec <cli> <profile> -- <cmd...>
```

`<profile>` 로 일시 swap → `<cmd>` 실행 → 명령 종료 시 원래 활성 프로필로 자동 원복.

```bash
# 한 번의 Claude 세션만 work 프로필로 실행, 종료 후 personal 로 원복
mat exec claude work -- claude

# lterm 과 조합
lterm send-keys "mat exec claude work -- claude" Enter
```

동작:

- `<cli>` 에 이미 활성 프로필이 설정되어 있어야 한다 (먼저 TUI 로 라이브 자격증명을 캡처).
- CLI 별 lockfile (`~/.multi-account-tool/locks/<cli>.lock`) 로 동일 CLI 의 `mat exec` 가 동시에 race 하지 않도록 직렬화. 비정상 종료로 남은 stale lock 은 자동 복구.
- 자식에 `SIGINT` / `SIGTERM` / `SIGHUP` 을 전달하고, 자식의 종료 코드/시그널을 그대로 반영한다.
- 원복은 `finally` 블록에서 일어나 정상 종료, 에러, 시그널 모두에서 실행된다. **단 `mat` 자체가 `SIGKILL` 을 받으면 원복은 일어나지 않는다** — 이 경우 활성 포인터가 `<profile>` 에 남으므로 TUI 로 다시 전환해야 한다.

이는 **시간 격리**이지 세션 격리가 아니다. 자식이 실행되는 동안 OS 전역 자격증명은 `<profile>` 의 것. 두 터미널에서 서로 다른 `mat exec` 를 동시에 띄우면 lock 으로 직렬화되며, 진짜 세션별 격리는 로드맵.

---

## 데이터 저장 위치

```
~/.multi-account-tool/
├── config.json                   # 활성 프로필 포인터 + 플래그
└── profiles/
    ├── claude/
    │   ├── personal/
    │   │   ├── credentials.json  # Keychain 항목 백업 (평문 JSON)
    │   │   └── meta.json
    │   └── work/...
    ├── codex/...
    └── gemini/...
```

파일은 `0600`, 디렉토리는 `0700` 권한으로 생성된다.

---

## 보안

### 수용한 trade-off (의도된 한계)

- **Keychain ACL 완화** — Claude 자격증명은 보통 Claude 바이너리만 접근할 수 있도록 Keychain ACL 이 걸려 있다. `mat` 은 swap 시 `security add-generic-password -A` 로 항목을 다시 만들어 같은 사용자의 모든 프로세스가 접근할 수 있게 한다 — 안 그러면 swap 후 Claude 가 자기 토큰을 읽지 못한다. 같은 UID 의 프로세스 (악의적 `npm postinstall` 등) 도 토큰을 읽을 수 있게 되는 점은 알고 있어야 한다. v0.2 에서 opt-in restrictive 모드 (`-T` 화이트리스트) 도입 예정.

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

v0.2+ 계획은 [ROADMAP.md](./ROADMAP.md) 참고:

- ~~커뮤니티 CLI 정의를 위한 플러그인 메커니즘~~ ✅ (v0.3)
- ~~Aider 빌트인 지원~~ ✅ (v0.3) + ~~Kimi / Qwen / Crush / OpenCode~~ ✅ (v0.3.x)
- 세션별 자격증명 격리 (`lterm` 세션마다 다른 계정)
- 빌트인 CLI 추가 확장 — ~~Goose~~ ✅ (v0.4-pre, account-scoped Keychain). Copilot / Amp 는 mat 추상화 추가 확장 (Linux Secret Service / Windows Credential Manager source type) 후 별도 PR 묶음 예정. Cursor Agent 는 plugin 권장 (keychain service name 공식 미공개).
- **Goose 한계**: mat 는 macOS Keychain (`goose`/`secrets`) 과 `~/.config/goose/*.yaml` 만 swap. Linux 에서 Goose 가 기본 `secret-service` 백엔드 (libsecret, GNOME Keyring/KWallet) 를 쓰면 mat 가 접근할 수 없으므로, Goose 의 keyring 을 끄고 (`GOOSE_DISABLE_KEYRING=1` 또는 `~/.config/goose/config.yaml` 의 file backend 설정) credentials 가 `secrets.yaml` 에 저장되도록 해야 한다.
- `lterm claude --profile <name>` 같은 shim wrapper

---

## 라이센스

MIT — [LICENSE](./LICENSE)
