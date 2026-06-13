# Command-scoped session run R&D — OpenCode/Aider/Antigravity follow-up

- **날짜**: 2026-06-12
- **상태**: 승인된 R&D/roadmap note + OpenCode/Aider runtime 후속 구현 반영
- **관련**: ROADMAP.md §2, `docs/superpowers/specs/2026-05-30-session-isolation-design.md`, `.omx/plans/g2-g3-session-unblock-rd.md`
- **목표**: 기존 `mat session start` 를 과장하지 않고, OpenCode/Aider/Antigravity 의 격리 가능성을 제품화 가능한 경계로 재정리한다.

---

## 1. 결론 요약

| 대상 | 결론 | 다음 제품 경로 |
| --- | --- | --- |
| OpenCode | `mat session start opencode` 는 계속 **EXPERIMENTAL** | 새 `mat session run opencode <profile> -- [opencode-args...]` 로 command-scoped safer-run 도입 가능 |
| Aider | `mat session start aider` 는 계속 **미지원** | `mat session run aider <profile> -- [aider-args...]` 는 forced config/env-file + env/argv/dotenv/OAuth-key/provider-chain/model-sidecar hard-stop 기반 partial support 로 구현됨 |
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
- `OPENCODE_DB`, `OPENCODE_MODELS_PATH`, `OPENCODE_MODELS_URL`, `OPENCODE_PERMISSION`, `OPENCODE_TEST_HOME`, `OPENCODE_TUI_CONFIG`, `OPENCODE_TEST_MANAGED_CONFIG_DIR`
- `attach`, `pr`, `--dangerously-skip-permissions`, `--share`, `--command`, `--file`/`-f`, cwd/project-directory argv (`--dir`, `--cwd`, path-like/existing directory/symlink args)
- provider credential env vars that OpenCode/provider integrations can consume directly (for example `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BEARER_TOKEN_BEDROCK`, `GOOGLE_APPLICATION_CREDENTIALS`, `SNOWFLAKE_CORTEX_PAT`, and generic `*_API_KEY`/token/secret/PAT patterns)
- project `.env` assignments for those provider credential env vars
- global/managed/home `.opencode`/project `config`, `config.json`, `opencode.json{,c}`, `tui.json{,c}`, `.opencode/*` 중 `{file:...}` substitution, plaintext `apiKey`, credential-bearing `headers`/`Authorization`, auth/service/bearer/access/refresh token options, AWS profile/credential-chain options, provider endpoint override, provider `npm`, `instructions`, `skills`, `reference(s)`, `share`, deprecated `mode`, agent `prompt`/`permission`/`tools`, `plugin`, `mcp`, `shell`, `formatter`/`lsp`/`command`, provider env reference, auth/content/config override 로 credential source 를 바꾸는 설정
- local plugin/tool/command/mode/agent/skill directories (`~/.config/opencode/plugin{s}/`, `~/.config/opencode/tool{s}/`, `~/.config/opencode/command{s}/`, `~/.config/opencode/mode{s}/`, `~/.config/opencode/agent{s}/`, `~/.config/opencode/skill{s}/`, `~/.agents/skills`, `~/.claude/skills`, home/project `.opencode/plugin{s}/`, home/project `.opencode/tool{s}/`, home/project `.opencode/command{s}/`, home/project `.opencode/mode{s}/`, home/project `.opencode/agent{s}/`, home/project `.opencode/skill{s}/`, project `.agents/skills`, project `.claude/skills`) with executable, shell-capable, prompt, permission, or SKILL.md files, because plugins/tools/commands/modes/agents/skills can inject env, execute hooks, override tools/permissions, read prompts, or run shell output at startup/use
- OpenCode `package.json` manifests in global/home/project config roots, because plugin/tool dependencies may be installed at startup
- symlinked/unreadable config candidates or macOS managed preference candidates whose contents cannot be proven safe
- Amazon Bedrock 의 AWS SDK shared-credential/metadata chain 과 Google ADC fallback 은 child env 에서 scrub (`AWS_SHARED_CREDENTIALS_FILE=/dev/null`, `AWS_CONFIG_FILE=/dev/null`, `AWS_EC2_METADATA_DISABLED=true`, `GOOGLE_APPLICATION_CREDENTIALS=/dev/null`) 하고, OpenCode `.claude` prompt/skills loading 은 `OPENCODE_DISABLE_CLAUDE_CODE* = true` 로 disable

향후 explicit override 를 추가하더라도, 그 실행은 “mat isolation guarantee 밖”으로 downgrade 해야 한다.

### 3.4 Acceptance tests

- `OPENCODE_AUTH_CONTENT` 가 있으면 hard refusal.
- `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` 가 있으면 hard refusal 또는 deterministic scrub; 어느 쪽이든 테스트로 고정.
- provider credential env (`AWS_BEARER_TOKEN_BEDROCK`, `ANTHROPIC_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `SNOWFLAKE_CORTEX_PAT` 등), provider endpoint override, 또는 `OPENCODE_PERMISSION` 이 있으면 hard refusal.
- project `.env` 의 provider credential assignment 는 hard refusal.
- config `instructions`, `skills`, `reference(s)`, `share`, deprecated `mode`, agent `prompt`/`permission`/`tools`, `plugin`, and non-empty local plugin/agent/skill directories are hard refusals.
- config `mcp` local server settings are hard refusals.
- config command channels such as `shell`/`formatter`/`lsp`/`command` are hard refusals.
- provider `npm` package selection is a hard refusal.
- OpenCode `package.json` manifests in config roots are hard refusals.
- `attach`, `pr`, `--dangerously-skip-permissions`, `--file`/`-f`, and cwd/project-directory argv are hard refusals.
- global `$XDG_CONFIG_HOME`/`~/.config/opencode/{config,config.json,opencode.json{,c},tui.json{,c}}` 의 plaintext `apiKey` 또는 executable/plugin config 는 hard refusal.
- project `opencode.json` 의 `{file:...}` substitution 또는 plaintext `apiKey` 는 current-to-git-root traversal 에서 hard refusal.
- `Authorization`/credential header, auth/service/bearer/access token option 또는 Amazon Bedrock `profile` 설정은 hard refusal.
- `.opencode/*.json{,c}` 의 env-backed provider key 는 hard refusal 또는 explicit no-isolation downgrade.
- safe run child env 는 AWS shared credential/config 파일, AWS metadata credential source, Google ADC credential source 를 scrub 하고 OpenCode `.claude` prompt/skills loading 을 disable 한다.
- symlinked/unreadable config candidates and unreadable/non-directory `.opencode` are hard refusals.
- 실행 후 profile 의 `opencode-auth.json` 은 격리본 rotation 만 재캡처되고 OS-global `$XDG_DATA_HOME/opencode/auth.json` 은 손대지 않는다.

---

## 4. Aider partial-run 경계

### 4.1 근거

Aider 공식 문서는 API key 입력 채널을 command line, environment variables, `.env`, `.aider.conf.yml` 로 설명한다. `.aider.conf.yml` 은 home, git root, current directory 순서로 load 되며 `--config <filename>` 이 있으면 지정한 config 하나만 load 된다고 설명한다. `.env` 도 home, git root, current directory, `--env-file <filename>` 순서로 load 된다. 공식 문서:

- <https://aider.chat/docs/config/api-keys.html>
- <https://aider.chat/docs/config/aider_conf.html>
- <https://aider.chat/docs/config/dotenv.html>

따라서 `mat session start aider` 는 지원하지 않는다. subshell 안에서 사용자가 `OPENAI_API_KEY=... aider`, `aider --api-key provider=...`, project `.env` 등을 얼마든지 우회할 수 있기 때문이다.

### 4.2 구현된 제품 경로 (partial support)

`mat session run aider <profile> -- [aider-args...]` 는 제품 지원하되 **partial support** 로 문서화한다. `mat session start aider` 는 여전히 미지원이다.

- mat profile 의 `aider.yml` 을 `<session>/command/aider.yml` 에 0600 command-only 격리본으로 복사한다.
- Aider 실행 argv 앞에 `--config <session>/command/aider.yml` 을 강제한다.
- `<session>/command/.env` 를 빈 0600 파일로 만들고 `--env-file <session>/command/.env` 를 강제한다.
- env root 를 열지 않는다. 즉 Aider home/config tree 전체를 격리한다고 주장하지 않고, mat 이 소유한 builtin `aider` 한 프로세스의 credential 입력 채널만 command-scoped 로 좁힌다. child env 에서는 AWS shared credentials/config/profile/container/metadata/web-identity 와 Google ADC/Cloud SDK credential fallback 을 `/dev/null` 또는 unset 으로 scrub 한다.
- command-only `aider.yml` 은 기존 세션 lifecycle 과 같은 재캡처 경로를 타며, `.env` 보조 파일은 재캡처하지 않고 폐기한다.

### 4.3 Hard-stop 기본값

아래 argv/env/ambient 파일은 기본값으로 **거부**한다.

- user argv 의 `--config`/`-c`, `--env`/`--env-file`, `--set-env` 및 이들의 argparse long-option 축약형
- `--openai-api-key`, `--anthropic-api-key`, `--api-key` 및 `--api-key=provider=value`
- provider endpoint/base override argv (`--openai-api-base`, `--openai-base-url`, `--api-base`, `--base-url` 등)
- model sidecar argv (`--model-settings-file`, `--model-metadata-file`)
- 모든 `AIDER_*` env
- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `DEEPSEEK_API_KEY`, `OPENAI_API_BASE`, `OPENAI_BASE_URL` 등 provider credential/endpoint env, AWS/Google/Vertex credential-chain env(`AWS_ACCESS_KEY_ID`, `AWS_PROFILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `VERTEXAI_PROJECT` 등), generic `*_API_KEY`, `*_TOKEN`, `*_SECRET_KEY` 계열 env
- home/project/git-root 탐색 범위의 `.env` 중 credential/provider/AWS/Google/Vertex assignment 를 담은 파일, symlink `.env`, unreadable `.env`
- non-empty/symlinked/unreadable `~/.aider/oauth-keys.env` (OpenRouter OAuth key dotenv)
- home/project/git-root 탐색 범위의 non-empty 또는 symlinked `.aider.model.settings.yml`, `.aider.model.metadata.json`
- profile `aider.yml` 내부의 `model-settings-file` / `model-metadata-file` pointer 및 `set-env`
- host AWS/Google credential chain 에 의존하는 Bedrock/Vertex model selector/listing 또는 alias target (`bedrock/...`, `vertex_ai/...`)

### 4.4 Blocking tests now covered

Aider partial-run 제품 표시는 아래 회귀 테스트 통과를 전제로 한다.

- forced `--config <session>/command/aider.yml` 와 forced empty `--env-file <session>/command/.env` 가 argv 앞에 주입된다.
- `session start aider` 는 계속 UsageError 로 막힌다.
- key-bearing/config/env/model-sidecar argv(축약 long-option 포함)는 profile lookup/read/spawn 전에 hard-stop 된다.
- provider/Aider/AWS/Google/Vertex ambient env 는 profile lookup/read/spawn 전에 hard-stop 되고, child env 는 AWS/Google credential-chain fallback 을 scrub 한다.
- home/current/parent `.env` credential/provider-chain assignment, symlink `.env`, unreadable `.env` 는 hard-stop 된다.
- `~/.aider/oauth-keys.env`, home/project model sidecar 후보와 symlink sidecar 는 hard-stop 된다.
- profile 내부 model-sidecar pointer/set-env 및 Bedrock/Vertex model selector/listing/alias 는 materialize 후 spawn 전에 hard-stop 되고 session dir 가 cleanup 된다.

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
4. ✅ **Aider partial-run** — forced config/env-file + env/argv/dotenv/OAuth-key/provider-chain/model-sidecar hard-stop + profile pointer cleanup tests.
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
- **Follow-ups**: OpenCode upstream `OPENCODE_DATA_DIR` 요청, Aider upstream config/dotenv/OAuth-key/provider-chain/model-sidecar drift monitor, Antigravity auth-store contract 조사/RFC.
