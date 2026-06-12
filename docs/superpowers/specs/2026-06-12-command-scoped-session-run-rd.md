# Command-scoped session run R&D — OpenCode/Aider/Antigravity follow-up

- **날짜**: 2026-06-12
- **상태**: 승인된 R&D/roadmap note (runtime 변경 없음)
- **관련**: ROADMAP.md §2, `docs/superpowers/specs/2026-05-30-session-isolation-design.md`, `.omx/plans/g2-g3-session-unblock-rd.md`
- **목표**: 기존 `mat session start` 를 과장하지 않고, OpenCode/Aider/Antigravity 의 격리 가능성을 제품화 가능한 경계로 재정리한다.

---

## 1. 결론 요약

| 대상 | 결론 | 다음 제품 경로 |
| --- | --- | --- |
| OpenCode | `mat session start opencode` 는 계속 **EXPERIMENTAL** | 새 `mat session run opencode <profile> -- [opencode-args...]` 로 command-scoped safer-run 도입 가능 |
| Aider | `mat session start aider` 는 계속 **미지원** | `mat session run aider <profile> -- [aider-args...]` 는 config/dotenv suppression negative test 통과 후 partial support 가능 |
| Google Antigravity / `agy` | swap/session 제품 지원 **blocked** | upstream auth-store 계약 또는 별도 research spike 만 허용 |

핵심 결정은 `session start` 의 범위를 넓히지 않는 것이다. `session start` 는 사용자의 `$SHELL` 을 열기 때문에 `PATH`, alias, absolute path, shell init file, project-local config, env var 를 전부 사용자가 우회할 수 있다. OpenCode/Aider 처럼 credential 채널이 config/env/CLI args 로 확장된 도구는 subshell 안에서 “무엇을 실행했는지”를 `mat` 이 통제할 수 없으므로 isolation claim 이 거짓이 된다.

대신 새 구조는 다음처럼 **내장 CLI 한 프로세스만** 실행한다.

```bash
mat session run <cli> <profile> -- [cli-args...]
```

여기서 `--` 뒤 인자는 임의 명령이 아니라 `<cli>` 에 대응하는 **mat 내장 executable** 에 전달되는 인자다. 예: `mat session run opencode work -- run "fix tests"` 는 `opencode run "fix tests"` 를 실행하되, `opencode` binary 선택과 격리 env/scrub/hard-stop 정책은 `mat` 이 소유한다.

---

## 2. 설계 원칙

1. **Warning 은 보안 경계가 아니다.** 우회 경로를 알고도 실행을 계속하면 사용자는 isolation 이 된다고 오해한다. 위험 채널은 hard-stop 또는 deterministic scrub 이 기본값이어야 한다.
2. **지원 단위는 “shell” 이 아니라 “내장 CLI command” 다.** command-scoped run 만이 argv/env/project probe 를 시작 전에 검증할 수 있다.
3. **제품 지원은 negative test 로 증명한다.** “문서상 그럴 것 같다”가 아니라 home/repo/current fixture 와 env/argv 우회 fixture 가 영향 없음 또는 hard refusal 을 증명해야 한다.
4. **Antigravity 는 별도 클래스다.** native keyring 기반 auth 는 file/env redirect 만으로는 격리할 수 없다. Linux 실험 성공만으로 macOS Keychain/Windows Credential Manager 안전성을 주장하지 않는다.

---

## 3. OpenCode safer-run 경계

### 3.1 근거

OpenCode 공식 config 문서는 config source 를 merge 하며, global config, `OPENCODE_CONFIG`, project config, `.opencode` directory, `OPENCODE_CONFIG_CONTENT`, managed settings 등 여러 채널을 문서화한다. 특히 project config 는 현재 디렉토리부터 git root 까지 탐색된다. 공식 문서: <https://opencode.ai/docs/config/>.

현재 mat 의 `session start opencode` 는 `XDG_DATA_HOME` 을 세션 디렉토리로 바꿔 `auth.json` 을 격리한다. 하지만 OpenCode 에 upstream `OPENCODE_DATA_DIR` 같은 CLI 전용 data redirect 가 없어서 broad `XDG_DATA_HOME` side effect 가 남고, config/env/project-local provider 설정은 `auth.json` 을 우회할 수 있다.

### 3.2 허용 가능한 제품 경로

`mat session run opencode <profile> -- [opencode-args...]` 를 추가한다.

- `mat` 이 `opencode` executable 을 직접 선택한다. 사용자가 `--` 뒤에 다른 command 를 넣을 수 없다.
- 격리 env 는 현행 `XDG_DATA_HOME=<session-root>/XDG_DATA_HOME` 을 재사용하되, 실행 대상이 OpenCode 하나라 broad XDG side effect 를 줄인다.
- 시작 전 위험 채널을 검사한다.

### 3.3 Hard-stop 기본값

아래 조건이 있으면 기본값은 **실행 거부**다.

- `OPENCODE_AUTH_CONTENT`
- `OPENCODE_CONFIG`
- `OPENCODE_CONFIG_CONTENT`
- `OPENCODE_CONFIG_DIR`
- current project 의 `opencode.json`, `opencode.jsonc`, `.opencode/*` 중 plaintext `apiKey`, provider env reference, auth/content/config override 로 credential source 를 바꾸는 설정
- shell env 의 provider key 가 OpenCode config 에서 참조되는 경우

향후 explicit override 를 추가하더라도, 그 실행은 “mat isolation guarantee 밖”으로 downgrade 해야 한다.

### 3.4 Acceptance tests

- `OPENCODE_AUTH_CONTENT` 가 있으면 hard refusal.
- `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` 가 있으면 hard refusal 또는 deterministic scrub; 어느 쪽이든 테스트로 고정.
- project `opencode.json` 의 plaintext `apiKey` 는 hard refusal.
- project `opencode.json` 의 env-backed provider key 는 hard refusal 또는 explicit no-isolation downgrade.
- 실행 후 profile 의 `opencode-auth.json` 은 격리본 rotation 만 재캡처되고 OS-global `$XDG_DATA_HOME/opencode/auth.json` 은 손대지 않는다.

---

## 4. Aider partial-run 경계

### 4.1 근거

Aider 공식 문서는 API key 입력 채널을 command line, environment variables, `.env`, `.aider.conf.yml` 로 설명한다. `.aider.conf.yml` 은 home, git root, current directory 순서로 load 되며 `--config <filename>` 이 있으면 지정한 config 하나만 load 된다고 설명한다. `.env` 도 home, git root, current directory, `--env-file <filename>` 순서로 load 된다. 공식 문서:

- <https://aider.chat/docs/config/api-keys.html>
- <https://aider.chat/docs/config/aider_conf.html>
- <https://aider.chat/docs/config/dotenv.html>

따라서 `mat session start aider` 는 지원하지 않는다. subshell 안에서 사용자가 `OPENAI_API_KEY=... aider`, `aider --api-key provider=...`, project `.env` 등을 얼마든지 우회할 수 있기 때문이다.

### 4.2 허용 가능한 제품 경로

`mat session run aider <profile> -- [aider-args...]` 를 추가하되, 최초 PR 에서는 **partial support** 로 문서화한다.

- mat profile 의 `aider.yml` 을 세션 디렉토리에 0600 복사한다.
- Aider 실행 argv 에 `--config <session/aider.yml>` 을 강제한다.
- empty/controlled `.env` 를 세션에 만들고 `--env-file <session/.env>` 를 강제하는 방식을 검증한다.
- provider API-key env 는 default-deny scrub list 로 제거하거나, 제거가 위험하면 hard refusal 한다.
- `--` 뒤 사용자가 넘긴 key-bearing args 는 hard refusal 한다.

### 4.3 Hard-stop 기본값

아래 argv/env 는 기본값으로 **거부**한다.

- `--openai-api-key`, `--anthropic-api-key`
- `--api-key` 및 `--api-key=provider=value`
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, 그 외 `/.*_API_KEY$/` provider key env
- `AIDER_OPENAI_API_KEY`, `AIDER_ANTHROPIC_API_KEY`, `AIDER_API_KEY`, `AIDER_ENV_FILE`, `AIDER_CONFIG` 등 Aider 자체 override env

### 4.4 Blocking tests before support

Aider partial-run 은 다음 negative test 없이는 제품 지원으로 표시하지 않는다.

- home `.aider.conf.yml` 이 존재해도 forced `--config <session/aider.yml>` 만 적용된다.
- repo root `.aider.conf.yml` 이 존재해도 forced config 만 적용된다.
- current directory `.aider.conf.yml` 이 존재해도 forced config 만 적용된다.
- home/repo/current `.env` 가 존재해도 forced `--env-file <session/.env>` 만 적용된다. 만약 Aider 가 docs 와 달리 여러 `.env` 를 함께 load 하면 support 는 blocked 로 유지한다.
- key-bearing argv 는 모두 hard refusal.
- provider API-key env 는 scrub 또는 hard refusal 로 deterministic 하게 처리된다.

---

## 5. Antigravity / `agy` block 조건

### 5.1 근거

Antigravity 공식 문서는 secure credentials/token profile 및 OS-native keyring auth 를 설명한다. 검색 가능한 공식 문서 스니펫과 local `agy --help` 기준으로, 현재 확인된 public CLI surface 에는 `AGY_HOME`, `ANTIGRAVITY_CONFIG_HOME`, `--auth-store`, `--data-dir` 같은 credential/data redirect contract 가 없다.

공식 문서:

- <https://antigravity.google/docs/cli-install>
- <https://antigravity.google/docs/cli-troubleshooting>
- <https://antigravity.google/docs/gcli-migration>
- <https://antigravity.google/docs/cli-reference>

### 5.2 제품 지원으로 넘어가기 위한 두 조건

Antigravity 는 아래 둘을 **모두** 만족하기 전까지 swap/session 지원을 추가하지 않는다.

1. Stable documented auth-store contract
   - CLI-specific auth/data redirect env 또는 flag, 또는
   - 플랫폼별 keyring service/account semantics 가 문서화되어 있고 version drift 를 감지할 수 있어야 한다.
2. Safe recapture story
   - token 내용을 읽거나 unrelated keychain entry 를 mutate 하지 않고, “이 profile 이 이 account/token 세대다”를 안전하게 저장/검증/갱신할 수 있어야 한다.

Linux private keyring/D-Bus/gnome-keyring sandbox 실험은 이 두 조건 중 일부만 검증한다. 따라서 성공해도 “research passed”일 뿐, 제품 지원으로 자동 승격하지 않는다.

---

## 6. PR decomposition

1. **Docs/R&D note** — 이 문서와 ROADMAP/README pointer 만 추가. runtime 변경 없음.
2. **`mat session run` framework** — built-in CLI executable allow-list, lifecycle, env materialize/recapture reuse, no arbitrary shell.
3. **OpenCode safer-run** — risk probe + hard-stop + tests.
4. **Aider partial-run** — forced config/env-file + env/argv hard-stop + negative tests.
5. **Antigravity research spike** — Linux private keyring 또는 upstream issue/RFC 조사. 제품 runtime 변경 없음.

---

## 7. ADR

- **Decision**: `mat session start` 를 OpenCode/Aider/Antigravity 로 넓히지 않고, command-scoped `mat session run <cli> <profile> -- [cli-args...]` 를 별도 제품 경로로 둔다.
- **Drivers**: isolation claim 의 정확성, 우회 채널에 대한 deterministic 처리, 기존 `session start` 사용자 기대 보존.
- **Alternatives considered**:
  - `session start` 에 warning 만 추가: 거부. warning 은 보안 경계가 아니며 shell 우회가 너무 쉽다.
  - Aider/OpenCode wrapper shell 제공: 거부. alias/PATH/absolute path/project config 를 통제할 수 없다.
  - Antigravity HOME redirect: 거부. 너무 광범위하고 native keyring auth 를 격리하지 못한다.
- **Why chosen**: command-scoped run 은 mat 이 executable, env, argv, project probe 를 시작 전에 검증할 수 있는 가장 좁은 경계다.
- **Consequences**: 새 명령이 필요하지만 기존 session semantics 를 오염시키지 않는다. Aider/OpenCode 는 더 엄격한 hard-stop UX 를 갖는다. Antigravity 는 blocked 상태가 명확해진다.
- **Follow-ups**: OpenCode upstream `OPENCODE_DATA_DIR` 요청, Aider config/dotenv bypass test, Antigravity auth-store contract 조사/RFC.
