# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Antigravity (`agy`) auth-store research note and support metadata now document why product support remains blocked until upstream publishes a stable credential-store, redirect, and recapture contract.
- Capture-time profile identity metadata for active-profile/status diagnostics. `mat status`, `mat doctor`, and `mat support` now surface only sanitized static identity hints (masked account/email fingerprints, allowlisted mode/tier signals) without parsing credential files or keyring secret entries during read-only diagnostics.


## [0.6.0] - 2026-06-14

Support-boundary explainability, read-only diagnostics, session-run preflight, and observability surfaces for automation/statusline consumers.

### Added

- `mat doctor [--json]` read-only safety diagnostics command. It reports active-profile/profile-directory state, metadata-safe live source presence, session support flags, plugin warnings, and high-confidence ambient override channels without reading credential values or OS-keyring secret entries.
- `mat support <cli> [--json]` and `mat explain <cli> [--json]` to explain per-CLI swap/freshness/session support boundaries, ambient override risks, and last-verified upstream assumptions.
- Warning-only ambient credential/config bypass notices for foreground profile switching and `mat exec`, reusing the same detector as `mat doctor`.
- `mat session run <cli> <profile> --check|--explain [--json] -- [cli-args...]` dry-run preflight reports. The check path reuses the exact real-run support/profile/executable/Aider/OpenCode validators without spawning the CLI or creating session state, exits `0` on pass, `1` on validation blockers, and `2` for usage errors.
- Observability substrate: `mat status [--json]`, `mat session list --json`, and best-effort redacted session lifecycle audit JSONL at `~/.multi-account-tool/audit.jsonl`.

### Changed

- Polished README and generated site wording for session observability, support-boundary explanation, OAuth rotation safety, and data-layout documentation.

## [0.5.2] - 2026-06-14

세션 안의 Codex skill 사용성을 복구하고, 관련 copy-isolation 설명 문서를 다듬은 patch 릴리스.

### Added

- Codex `mat session start` now copy-isolates `~/.codex/skills` into the session `CODEX_HOME/skills`, so skills are available in isolated profile shells without live-sharing or write-back to the source tree.

### Changed

- Polished README and generated site wording for session copy-isolation, clarifying that Codex `config.toml` and `skills/` are session-local snapshots and are never written back.

## [0.5.1] - 2026-06-13

v0.5.0 이후 세션 command-run 확장, OpenCode/Aider command-scoped 경계,
그리고 foreground/session credential boundary 보안 하드닝을 묶은 patch 릴리스.

### Added

- **`mat session run` command-scoped 실행 프레임워크 (#84)** — shell 을 열지 않고
  builtin CLI executable 을 직접 spawn 하며 `[cli-args...]` 를 argv 로 전달하는 세션
  실행 경로 추가. `session start` 와 같은 materialize → env 주입 → 재캡처 → cleanup
  lifecycle 을 공유한다.
- **OpenCode 세션 지원 확대 (#78/#85)** — `XDG_DATA_HOME` 기반 experimental
  `session start` 와, 더 좁은 `mat session run opencode ...` safer-run 경계 추가.
  local config/env/plugin/tool/MCP/command/argv 우회 채널을 preflight hard-stop 하고
  `.claude` prompt/skills fallback 을 차단한다.
- **Aider partial-run 지원 (#86)** — `mat session run aider` 가 command-only 세션
  디렉토리에 profile `aider.yml` 과 빈 `.env` 를 materialize 한 뒤 forced
  `--config`/`--env-file` 로 실행한다. `session start aider` 는 계속 미지원.
- **세션 지원 CLI 확대 (#77)** — Gemini CLI `envSubdir` 경로와 Linux Claude
  `CLAUDE_CONFIG_DIR` 세션 격리 지원 추가.

### Changed

- **세션/문서 사이트 갱신 (#83/#92)** — README/README.ko 와 생성된 site 문서에
  `session run`, OpenCode/Aider 한계, ambient credential env scrub 범위를 명확화.
- **CI 액션 핀 갱신 (#82)** — `actions/checkout` 을 6.0.3 commit SHA 로 갱신.

### Fixed

- **allow-list path 오류 sanitize (#81)** — 세션 allow-list 경로 오류가 민감 경로를
  그대로 노출하지 않도록 보강.
- **same-active missing profile guard (#89)** — 이미 활성으로 표시된 profile 로
  switch 할 때 실제 profile 디렉토리가 없으면 silent success 대신 실패 처리.

### Security

- **atomic write / redaction hardening (#87)** — atomic write 및 오류/로그 redaction
  경계 보강.
- **foreground credential mutation 직렬화 (#88)** — foreground credential mutation 을
  전역 lock 으로 serialize 하고 stale async context 회귀를 차단.
- **session child credential env scrub (#90/#91/#92)** — `mat session start/run`
  자식이 parent shell 의 고신뢰 provider/API endpoint env 및 AWS/GCP credential-chain
  env 를 상속해 profile copy-isolation 을 우회하지 못하게 scrub/hardening. Kimi,
  Qwen/DashScope, OpenCode env/config 우회 키를 포함하고, 전체 deny/hardening
  정책과 `target.env`/root env merge order 를 black-box 테스트로 고정.

## [0.5.0] - 2026-06-02

세션별 자격증명 격리(`mat session`) 출시 + macOS 전용 keychain 을 3-OS keyring
추상화로 확장(Linux Secret Service `secret-tool`, Goose Linux 재진입) + freshness/
세션 동시성·공급망 보안 하드닝 사이클. v0.4.1 이후 25 PR (#46~#75) 머지.

### Added

- **`mat session` — 세션별 자격증명 격리 (#61)** — 터미널마다 다른 AI CLI 계정을
  동시에 쓰는 신규 서브커맨드. `mat session start/list/stop`. env 주입(`CODEX_HOME`
  등) + **copy-isolate**(자격증명 0600 복사, symlink 아님) + 종료 시 재캡처. 전역
  swap/lock 미사용 → 동시 다계정. 지원: codex/qwen/kimi/crush. 재캡처 **2-phase
  commit**(stage→commit, late-land split 차단) · **tri-state `classifyOwner`**
  (owner/dead-or-reused/unknown — unknown 이면 삭제 안 함, wrong-kill 방지) · `ps -o
  lstart` 시작서명(`v1:` 버전화, pid 재사용 방어). 스펙
  `docs/superpowers/specs/2026-05-30-session-isolation-design.md`.
- **OS keyring source type — Linux Secret Service 지원 (#53/#54/#55/#57/#58)** —
  macOS 전용 `keychain` source 를 `os-keyring` 추상화로 확장. `OsKeyringSource`
  타입 + exhaustiveness 가드(PR-1) · `parseSource` 의 service/account/backend enum
  검증(PR-2) · `runCommand` stdin 주입 경로(secret 을 argv 아닌 stdin 으로, PR-3a)
  · `secret-tool` search/clear/store 실제 구현(`src/core/os-keyring.ts` 신규, PR-3b)
  · **Goose Linux 를 os-keyring source 로 swap**(PR-4, #58). PR #29(Goose)/#30
  (Copilot) Linux 재진입 기반 확보.
- **`mat freshness --check-only` 플래그 (#46)** — stale/low-conf rotated/inflight
  감지해도 exit 0 반환(stdout 표·JSON 출력은 유지). status line widget / dashboard
  등 read-only 모니터링 케이스가 정보는 받되 CI chain 의 exit 1 차단은 안 받게 함.
  `UnknownCliError`(exit 2)/fs 에러(exit 74)는 우회하지 않음.
- **프로필 단위 재캡처 advisory 락 (#62, #69)** — 동시 같은-프로필 multi-cred
  (Qwen/Crush) split(cred 별 토큰 세대 혼합) 차단. `locks/recapture/<cli>/<profile>`
  중첩 네임스페이스(exec cli-lock 과 별도) + bounded-wait(`RECAPTURE_LOCK_WAIT_MS`
  =5000) + best-effort lock-free degrade. backup-read 를 락 안으로(TOCTOU 차단).
- **세션 격리 잔여 개선 — unknown TTL + child-pid 추적 + codex config 공유 (#63,
  #71)** — unknown 세션 bounded TTL 정리(`UNKNOWN_TTL_MS`=24h, env override) ·
  서브셸 child-pid 추적(`classifyChildOwner` 가드로 자식 생존 시 보존) · codex
  `config.toml` allow-list 공유.
- **adapter 분류 contract test 인프라 + Docker Linux 개발 환경 (#50/#56)** —
  fixture-based 분류 회귀 가드(`tests/contract/adapters.test.ts` + 20 fixture,
  `test:contract` script) · `docker/`(ubuntu+libsecret-tools/gnome-keyring/dbus)
  Linux Secret Service 개발/테스트 환경(`scripts/secret-tool-e2e.sh`).
- **README 문서 사이트 — GitHub Pages, EN/KO (#64/#65/#66)** — README→HTML 빌드
  (`scripts/build-docs.mjs`) + GitHub Actions Pages 배포. "clean modern docs"
  디자인(IBM Plex, 라이트/다크 토글, TOC scroll-spy, 반응형).
  https://ictechgy.github.io/multi-account-tool/

### Changed

- **inflight cross-source aggregation 실제 구현 (#52)** — 옛엔 inflight 분류
  코드만 있고 발생 path 부재 → `aggregateInflight` 로 cross-source 집계 실제화.
- **`maskIdentifier` 8 → 12 hex + `MASKING_RULES.md` 정식 문서화 (#51)** —
  fingerprint 32-bit → 48-bit(~65K → ~16M birthday bound, fleet/audit 안전).
  fixture 마스킹 규칙·금지 패턴·정적 분석 우회 가이드 매트릭스 문서화.
- **`app.tsx` 순수 helper 4 모듈 분리 + `keychainSet` 3 helper 분해 (#47/#49)** —
  `app.tsx` 1190→960 lines(`src/app/{state,formatters,validators,log}.ts` 추출) ·
  `keychainSet` 4 책임(backup/delete/add/rollback)을 helper 3개로(CLAUDE.md ≤10
  lines, `KeychainBackup.account` 타입으로 invariant 강제). 동작 동일.
- **CI: GitHub Actions 를 node24 런타임으로 범프 (#67)** — checkout/setup-node/
  configure-pages/upload-pages-artifact/deploy-pages 메이저 업데이트(node20
  deprecation 대응). `git ls-remote`/raw `action.yml` 로 권위 확인.

### Fixed

- **codex `config.toml` 공유 symlink → copy-isolate 전환 — write-back 차단 (#72,
  #74)** — codex 가 `config.toml` 에 실제로 씀(mcp add 시 `[mcp_servers.*]`)을
  실측 → symlink 공유 시 base `~/.codex/config.toml` 오염(write-back)·동시 세션
  간섭. `materializeShareLink`→`materializeShareCopy`(`O_NOFOLLOW` 읽기 + atomic
  격리본 복사)로 write-back 구조적 제거. 기존 보안 봉쇄 전부 보존.
- **Goose Linux `secret-tool` 미설치(ENOENT) 읽기 soft-fail (#59, #73)** —
  libsecret-tools 미설치 회귀 해소. 읽기에서 spawn ENOENT 만 soft-fail(→secrets.yaml
  fallback)+강한 stderr 경고. EACCES 등 다른 실패·daemon-down·쓰기는 fail-closed
  throw 유지(`spawnErrno` 로 ENOENT 정확 구분).
- **Goose Linux file-backend gating — `GOOSE_DISABLE_KEYRING` (#59, #60)** — 양성
  증거가 있을 때만 os-keyring 생략하고 file backend 사용.
- **persist 실패 안내 stderr → `app.log` 전환 (#48)** — Ink alternate-buffer
  모드에서 stderr 가 화면 렌더와 충돌하던 문제를 `~/.multi-account-tool/app.log`
  append(0600)로 회피. 디버그 audit trail 보존.

### Security

- **GitHub Actions 를 commit SHA 로 핀 + Dependabot 도입 (#68, #70)** — 가변 태그
  (@v6) → 40-hex commit SHA 핀(공급망 강화) + `.github/dependabot.yml`(github-actions
  weekly) + publish 워크플로 node 22 + `npm@11.16.0` 정확 핀. SHA 는 `git ls-remote`
  로 권위 확정.

## [0.4.1] - 2026-05-29

v0.4.0 publish 후 사용자 가시 docs 정확화 + freshness adapter 보안·DRY 강화 +
Goose YAML parser 정식 lib 교체 사이클. 5 PR (PR-J/PR-K/PR-L/PR-M/PR-N) 머지.

### Changed

- **README docs publish-followup 6건 + smoke-test 단언 갱신 — PR-J (#40)** —
  데이터 layout tree 가 9 CLI (claude/codex/gemini/aider/kimi/qwen/crush/opencode/
  goose) + `cli-defs/` + `locks/<cli>.lock/` 디렉토리 모두 명시. Usage 섹션에
  `mat --version` / `mat --help` 안내. lterm 예시 footnote (`npm install -g
  @ictechgy/lterm` 별도 설치 필요). OAuth Rotation Safety Matrix 의 Aider/Kimi/
  Qwen/Crush 행에 env/project-local override 한계 footnote. 신규 "플랫폼 지원"
  섹션 — per-CLI macOS/Linux/Windows 지원 + Override/한계 매트릭스. Install 섹션
  에 "설치 확인" 하위 섹션 (`mat --version` / `mat --help` / `node scripts/
  smoke-test.mjs` 안내, read-only 명시). `scripts/smoke-test.mjs` 의 stale 단언
  (`BUILTIN_CLI_DEFS.length === 3`) 을 `>= 1` + `=== BUILTIN_CLI_DEFS.length` 로
  완화 — v0.3.x 이후 빌트인 확장 시 false-negative 방지. README.md 와 README.ko.md
  대칭 적용. quad-review iter 1 의 MED 1건 (qwen/crush profile tree filename
  mismatch: 실제 saveAs 는 `qwen-settings.json` + `qwen.env` + `crush-config.json`
  + `crush-data.json` 의 prefix 적용 형태) fix.
- **`_shared.parseJsonObject` 5 adapter DRY 통일 — PR-K (#41)** — PR-H 에서
  claude/goose 에만 적용된 `_shared.parseJsonObject` 를 codex/gemini/opencode 3
  adapter 에도 적용. local `parse()` / `parseObject()` 함수 제거 → `parseJsonObject
  <T>` 사용. 의도된 strictness 강화: `parseJsonObject` 는 `Array.isArray(v) ===
  true` 도 reject (옛 local parse 는 `typeof === 'object'` 만 검사 → array 통과).
  array 입력은 명시적 null → `rotated/both/low confidence parse 실패` 분류 — 옛
  opencode 의 `Object.keys(s)` loop 가 numeric index 로 잘못 진입할 위험 차단.
  회귀 가드 +4 (codex/gemini oauth_creds/gemini google_accounts/opencode 의 array
  reject 가드). 5 adapter 가 단일 helper 사용 → 향후 보안 정책 변경 시 single
  point of update 확보.
- **Goose YAML parser → `yaml@~2.9.0` 정식 lib 교체 — PR-M (#43)** — 옛 간이
  flat YAML parser (`parseFlatYaml`) 의 한계 (block scalar `|`/`>` 감지 시
  confidence 강등, 사용자 multi-line API key 사용 시 false-positive low-conf
  다발) 를 `yaml` v2 (YAML 1.2 spec, eemeli.org/yaml, zero-dep) 로 교체. block
  scalar / quoted / anchor / alias 정식 해석 → resolved string 이 entries 에
  그대로. `BLOCK_SCALAR_VALUE_RE` / `hasBlockScalar` / `downgradeForBlockScalar`
  / `stripQuotes` 제거. YAML parse 실패 (spec 위반, 닫히지 않은 quote, multi-
  document, malformed indentation 등) → `hasParseError` flag → `downgradeFor
  ParseError` 로 confidence 강등 + detail hint. 1-depth `Record<string, string>`
  contract 유지 — nested object / array 는 매트릭스 미진입 (follow-up). `Object.
  create(null)` + `DANGEROUS_KEYS` (M3 prototype pollution 가드) 유지.
  quad-review (Claude×2 + Codex×2) 2 iteration HIGH 3 + MED 2 + LOW 3 fix:
  (1) block scalar trailing newline 비대칭 회귀 — yaml v2 `|` clip = `"v\n"` vs
  `|-` strip = `"v"` 로 동일 본문이 value-only 오분류, `parseGooseYaml` 에서
  entries[key] 저장 전 `/\n+$/` strip 정규화 — chomping 마커 차이만 있는 동일
  secret 은 meta-only 로 정확 분류. (2) numeric/boolean/null silent skip 회귀 —
  YAML 1.2 scalar tag resolution 으로 `3.5` / `true` / `null` 등 비-string type
  parse, 옛 string-only filter 가 silent skip → `sameKeySet` 비대칭 → false-
  positive stale, `coerceToIdentityString` 도입으로 number/boolean/bigint primitive
  를 `String()` 강제 변환 (null/undefined/nested 는 skip 유지). (3) `yaml@^2`
  caret range → `~2.9.0` narrow (parser behavior 가 분류 결과에 직접 영향, npm
  publish 사용자가 lockfile 없이 install 시 minor bump 차단). (4) JSDoc 의
  "strict 옵션 미사용 (default lenient)" 정정 → "yaml v2 default 는 strict, spec
  위반은 throw → catch 로 hasParseError surface" 명시. (5) `parseYaml(raw, {
  maxAliasCount: 100, logLevel: 'error' })` 옵션 추가 — billion laughs / anchor-
  alias exponential expansion 방어 lock-in + warning stderr side effect 차단.
  회귀 가드 +9 (block scalar chomping / numeric / boolean / null / multi-doc /
  parse 실패 / matrix-key boolean / matrix-key null).
- **`RECAPTURE_TIMEOUT_MS` lazy function 전환 — PR-N (#44)** — 옛 코드의
  module-level `const RECAPTURE_TIMEOUT_MS = parseRecaptureTimeoutMs()` 는 module-
  load 시점 1회 평가. `MAT_EXEC_RECAPTURE_TIMEOUT_MS` env 가 module import 후
  set 되면 무효 — test / daemon-TUI 통합 케이스에서 env override 가 첫 spawn 후
  무시. `getRecaptureTimeoutMs()` getter 함수로 전환 → 호출 시점 평가. daemon/TUI
  가 mat exec 를 여러 번 spawn 할 때 env 변경이 다음 spawn 부터 즉시 반영. 회귀
  가드 +1 (env 동적 설정 + fake-timer 600ms advance → `timeout after 500ms`
  메시지 검증).

### Fixed

- **freshness adapter throw path 의 secret leak 차단 — PR-L (#42)** —
  `SourceAdapter` contract (`freshness.ts:76-87`) 는 정상 return 의 `detail` 만
  secret leak 방어 의무화. throw path 는 `freshness.ts:364-376` catch 가
  `(err as Error).message` 를 그대로 detail 에 append → adapter 가 raw payload
  (refresh_token / JWT / accountId) 일부를 error message 에 포함했을 경우
  `mat freshness --json` CI 로그 / TUI dialog 에 secret 누설. PR-H 에서 `_shared.
  redactSecretLikeMessage` helper 만 export 하고 catch 적용은 deferred 됐던 M4
  완성. catch 의 `adapterMsg` 를 `redactSecretLikeMessage` 통과 → base64-like 20자+
  → `<redacted>`, JWT prefix → `<redacted-jwt>`, 120자 cap. 회귀 가드 +1 (JWT-
  like prefix + base64-like 20자+ 포함 throw → detail 원본 시퀀스 부재 + `<redacted>`
  마커 검증, 가짜 토큰은 runtime concat 으로 구성해 정적 secret scanner 회피).

### Security

- **`yaml@~2.9.0` (zero-dep, npm audit 0 vulnerabilities)** — PR-M. `package.json`
  dependencies 에 `yaml` 추가 + `~2.9.0` narrow 로 lockfile 없는 install 환경에서도
  minor bump 차단. `maxAliasCount: 100` explicit (billion laughs / YAML bomb
  방어, yaml lib default 변경 대비 lock-in). `logLevel: 'error'` 로 parse warning
  의 stderr 출력 차단 (compare() 의 pure return contract 보존).

## [0.4.0] - 2026-05-28

OAuth refresh token rotation 종합 대응 사이클 + Goose 빌트인 추가. plan
`.omc/plans/oauth-refresh-rotation-conflict.md` (ralplan --deliberate 3 iteration
합의) 의 6 PR (PR-A / PR-C / PR-F* / PR-G / PR-I* / PR-H) 모두 머지 완료.

핵심 사용자 가시 효과:
- 신규 `mat freshness [<cli>] [--profile <name>] [--json]` CLI subcommand — swap
  전 라이브 vs 활성 프로필 자격증명 비교 보고 (CI chain 자동 차단 가능).
- TUI swap/create 시 freshness drift 감지 → **재캡처 / 폐기 / 취소** 3-옵션
  dialog (PR-G).
- `mat exec` 종료 시 라이브 재캡처 (PR-I*) — cmd 가 자체적으로 OAuth refresh
  rotation 한 경우 새 토큰 손실 방지.
- Claude/Goose identity-aware adapter (PR-H) — byte-diff fallback 의 false-positive
  (low confidence dialog noise) 제거.
- **9번째 빌트인 Goose** 추가 (Block 의 오픈소스 AI agent).
- 9 CLI 의 OAuth Rotation Safety Matrix 가 README 에 명시 (사용자가 swap 안전성
  사전 파악 가능).

### Added

- **Claude / Goose identity-aware freshness adapter — PR-H** — `src/core/freshness-adapters/{claude,goose}.ts` 신규. **Claude adapter** 가 `KeychainStored` wrapper (macOS) + raw credentials JSON (비-macOS) 양쪽 처리 — `claudeAiOauth.{accessToken/refreshToken/expiresAt/subscriptionType}` + macOS keychain `account` 메타로 4-state 분류 (fresh / rotated value-only|meta-only|both / stale). identity 변경 (subscriptionType 변경 또는 keychain account 변경) → stale, 동일 identity + token 변경 → rotated value-only (high confidence). **Goose adapter** 가 3 saveAs 분기 (goose-keyring.json macOS keychain wrapper + goose-secrets.yaml + goose-config.yaml) — 간이 flat YAML parser 로 provider key 매트릭스 (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `GOOGLE_API_KEY` / `GROQ_API_KEY` / `DATABRICKS_TOKEN` / 일반 `*_API_KEY` / `*_TOKEN` 등) 추출. provider 키 set 변경 → stale, 값 변경 → rotated value-only, 외 필드 변경 → meta-only. keyring inner value 는 secrets.yaml 본문 그대로 (Goose 가 `keyring::set_password` 으로 YAML 직렬화) — wrapper outer parse 후 YAML 비교 위임. 두 adapter 모두 `registerAllBuiltinAdapters` 에 등록 — PR-F* 의 byte-diff fallback false-positive (`confidence: low`) 제거. README/README.ko 의 OAuth Rotation Safety Matrix 에서 Claude/Goose 🟠 → 🟢 완화됨 (identity-aware) 으로 변경. 한계 명시: Claude credentials.json 에 안정적 user_id/email 부재 — 같은 subscriptionType 의 다른 계정으로 swap 시 stale 못 잡고 rotated 분류 (보수적). Goose 의 API key 자체에 provider 신원 정보 없음 — 같은 provider 의 다른 키로 swap 시 rotated value-only 분류. 회귀 가드 +23 (claude.test 10 + goose.test 13: byte-identical, rotation, identity 변경, multi-provider, parse 실패, quoted YAML, 주석/들여쓰기, 미지원 saveAs 등).
- **`mat exec` 종료 시 라이브 재캡처 + LockBody 확장 — PR-I*** — `mat exec <cli> <P> -- <cmd>` 의 cmd 가 자체적으로 OAuth refresh rotation 을 수행해 라이브 토큰을 갱신했을 때, 종료 시점 (finally + trap 가능 signal handler SIGINT/SIGTERM/SIGHUP) 에 `snapshotLiveToProfile(cliId, swapTarget)` 로 라이브를 swap-target 프로필에 재캡처한 뒤 `switchProfile(cliId, previousActive, { skipPreSwapSnapshot: true })` 로 원래 활성 프로필 복원. 기존엔 단순 `switchProfile(cliId, previousActive)` 만 호출돼 cmd 가 갱신한 새 토큰이 옛 토큰으로 덮어써져 손실될 위험 (provider 가 옛 `refresh_token` revoke → 강제 재로그인) 이 있었음. 재캡처 실패는 best-effort (stderr 안내 후 restore 진행) — restore 실패는 기존 동작 동일 (exit 74 매핑). `acquireCliLock` 에 신규 옵션 `{ execMode, previousActive, affectsCliIds }` 추가 — `LockBody` 에 `execMode: 'foreground' | 'exec'` + `previousActive?: string` + `affectsCliIds?: string[]` 필드 보존. `readInfo` 가 신규 필드 부재 (옛 mat 으로 생성된 info.json) 도 backward-compat 처리. **stale recovery 정책 B (warn + drop)**: SIGKILL 등 trap 불가 signal 로 mat 이 강제 종료된 뒤 다음 mat 호출의 `handleConflict` 가 dead pid 의 lock 을 회수할 때, LockBody `previousActive` 가 있으면 "라이브 자격증명이 활성 프로필 'X' 이 아닌 'Y' 의 것일 수 있음" stderr 안내, 없으면 (옛 lock) "이전 mat 버전의 exec lock" 안내 후 폐기. `affectsCliIds` 는 향후 cross-cli OAuth provider 공유 시나리오를 위한 schema 예약 (현재는 단일 `[cliId]`). 회귀 가드 +20 (lockfile 9: LockBody schema 매트릭스 + 정책 B 4분기 stderr 분기 + sanitizeForStderr + readInfo backward-compat, exec 11: acquireCliLock 옵션 검증 + snapshot 호출 + skipPreSwapSnapshot + 재캡처 실패 swallow + already-active + spawn error 후 재캡처 + SIGINT/SIGTERM/SIGHUP 매트릭스 3 + timeout fake-timer + 기존 ordering 갱신). SIGKILL / SIGSEGV / SIGBUS 는 OS 보장상 trap 불가 — finally / signal handler 모두 미실행, stale recovery 만 가능 (exec.ts docstring 명시). quad-review iter 1 fix 통합: `withTimeout` (default 10s, `MAT_EXEC_RECAPTURE_TIMEOUT_MS` override) 으로 keychain prompt hang 차단, `warnStaleLockRecovery` 4분기 (exec+previousActive / exec corrupt / foreground / legacy), `sanitizeForStderr` (control char strip + 200자 cap) 로 terminal escape injection 방어. Plan: `.omc/plans/oauth-refresh-rotation-conflict.md` PR-I*.
- **TUI freshness rotation dialog (재캡처/폐기/취소) — PR-G** — swap/create 직전 `inspectLiveFreshness(cli, currentActive)` 후 `needsUserAttention(report)` 검사. `rotated`/`stale` 감지 시 사용자에게 3-옵션 dialog: **재캡처** (`snapshotLiveToProfile(cli.id, currentActive)` 후 `switchProfile(skipPreSwapSnapshot=true)` 로 swap — 라이브 회전 토큰을 활성 프로필에 저장 후 swap), **폐기** (`switchProfile(skipPreSwapSnapshot=true)` — 자동 snapshot 생략, 라이브가 toProfile 저장본으로 덮어써짐, 의도된 데이터 손실), **취소** (swap 미실행, dispatch pop). `inflight` 감지 시 재시도 안내. profile create 시에도 동일 hook (`onAddSubmit` → `inspectAndRouteFreshness` helper 재사용). 첫 dialog 표시 시 `firstFreshnessPromptShown=true` 기록 + 한국어 onboarding 패널 1회 표시. reducer action `mark-freshness-prompt-shown` 으로 in-memory 즉시 갱신 (file persist 와 분리). `FreshnessDialog` 컴포넌트 + `useFreshnessDialogKeys` hook + 4 서브컴포넌트 (Header/Target/Sources/Options) 로 분리. quad-review iter 2 HIGH 3 + 핵심 5건 fix: `reAssertActiveProfile` 가드 (dialog ~ 사용자 결정 사이 active 변경 race 차단), `switchProfile(current===toProfile)` 무조건 no-op (public API 데이터 손실 차단), `inspectAndRouteFreshness` helper 추출, `result.detail` defensive sanitize (token-like 32자+ → `[redacted]`, 256자 truncate). 회귀 가드 +19 (`app.tsx` 흐름 함수 매트릭스 + `FreshnessDialog` 키바인딩 invariant + `needsUserAttention` predicate + `hasInflight ⇒ needsUserAttention` invariant 등). Plan: `.omc/plans/oauth-refresh-rotation-conflict.md` PR-G.
- **OAuth refresh rotation 인지 freshness 점검 — PR-F*** — `src/core/freshness.ts` 신규 모듈 + `src/core/freshness-adapters/{codex,gemini,opencode}.ts` adapter. 라이브 자격증명 vs 활성 프로필 저장본 비교 → 4-state (`fresh` / `rotated` / `stale` / `inflight`) + `rotated` subtype (`value-only` / `meta-only` / `both`) + confidence (`high` / `medium` / `low`) 분류. CLI 별 `SourceAdapter` 가 identity 필드 (Codex `tokens.account_id`, Gemini `google_accounts.json.active`, OpenCode `provider.accountId`) 비교로 token rotation vs 다른 계정 구분 — wrong-restore 로 인한 `refresh_token_reused` 401 사고 사전 감지. adapter 미정의 CLI 는 화이트리스트 byte-diff fallback (`refresh_token` / `access_token` / `id_token` / `account_id` 필드만 normalize 비교, `last_refresh` / `expiry_date` / `expires` 등 캐시 필드는 무시). `switchProfile` 결과 `SwitchResult.preSwapLiveFreshness?: FreshnessReport` 추가 — info-only (기존 호출자 영향 0). 신규 `mat freshness [<cli>] [--profile <name>] [--json]` CLI subcommand: exit 0 (전체 안전, fresh/rotated 포함) / 1 (`stale` 또는 low-conf `rotated` / `inflight` 감지, CI chain 차단 의도) / 2 (usage) / 74 (검사 실패). README + README.ko + ROADMAP 에 OAuth Rotation Safety Matrix (9 CLI) + `mat freshness` 사용 가이드 추가. 회귀 가드 +46 (freshness.test 16 + codex adapter 7 + gemini adapter 9 + opencode adapter 11 + switcher preSwapLiveFreshness 4 — plan §99-100 의 +34 목표 초과 달성). Plan: `.omc/plans/oauth-refresh-rotation-conflict.md` (ralplan --deliberate 3 iteration 합의). 본 PR 가 v0.4.0 OAuth rotation 안전성 시리즈의 시작 — 후속 PR-G (TUI dialog 재캡처/폐기/취소), PR-I* (mat exec 종료 rotation 재캡처), PR-H (Claude/Goose identity-aware adapter) 가 모두 v0.4.0 에 함께 머지되어 PR-F* 의 byte-diff fallback dialog noise 까지 해소된 완전체.
- **`KeychainSource.account` optional 필드** — `src/core/types.ts` 의 `KeychainSource` 인터페이스에 `account?: string` 추가. 정의에 명시되면 mat 의 모든 keychain 조작 (`find` / `delete` / `add` / `exists`) 이 `-s service -a account` 항목 하나로 scope 제한 — 동일 service 의 타 account 항목은 영향 없음. Goose (service `goose`, account `secrets` 단일 entry) / GitHub Copilot CLI (`/user switch` multi-account) 류 generic service · multi-account 도구의 wrong-entry swap 을 차단. 미지정 시 기존 단일-account 동작 유지 (Claude/Codex 등 회귀 없음). `cli-defs-plugin` loader 도 raw JSON 의 `account` (optional) 파싱 — typeof string + non-empty + NUL 차단. 새 항목 add 시 account 우선순위: `src.account` > `stored.account` > `$USER` > `'default'` — 정의에 명시된 account 가 캡처 당시 stored 와 다르더라도 정의가 의도한 account 로 복원. multi-account scope 회귀 가드 12건 (`sources.test.ts` 다른 account 항목 보호 시나리오 + `cli-defs-plugin.test.ts` account 필드 파싱).
- **Goose 빌트인** — `BUILTIN_CLI_DEFS` 9번째 항목. PR-A `KeychainSource.account` 필드를 사용하는 첫 builtin (보류된 PR #29 의 wrong-entry 위험 해결 후 재PR). Block 의 오픈소스 AI agent (https://github.com/block/goose). **platform 분기 multi-source**: macOS = keychain (`service: 'goose', account: 'secrets'`) + `~/.config/goose/secrets.yaml` + `~/.config/goose/config.yaml` (3-source). 그 외 (Linux/Windows/BSD) = yaml 2-source. service `goose` 가 generic 단어라 PR-A 의 `account` scope 없이는 동일 service 의 타 항목 잘못 잡을 위험이 있었음 (PR #29 closed 사유 해소). plugin 으로 'goose' override 차단 회귀 가드 (cli-defs.test.ts + cli-defs-plugin.test.ts). **Linux 한계 (README/ROADMAP 명시)**: Goose 기본 `secret-service` 백엔드 (libsecret, GNOME Keyring/KWallet) 는 mat 미지원 → 사용자가 `GOOSE_DISABLE_KEYRING=1` 또는 file backend 설정으로 credentials 가 `secrets.yaml` 에 저장되도록 해야 함. project-local override / shell env 는 mat scope 밖. README 한국어/영어 + ROADMAP universe 갱신 (Goose ⛔ → ✅).

### Security

- **`assertValidKeychainSource` source-boundary 가드** — quad-review 합의 (Claude × 2 + Codex × 2, HIGH) 반영. `src.account` 가 정의되었는데 유효하지 않으면 (빈 문자열 / NUL 포함) `readKeychainSerialized` / `writeKeychainSerialized` / `sourceExists` 의 keychain 분기 진입부에서 명시 throw — 이전엔 `hasAccount('')` 가 false 로 떨어져 `keychainSet` 의 `scopeAccount` 인자가 service-only 로 fallback, 동일 service 의 임의 account 항목을 잘못 잡아 backup/delete 로 영구 삭제할 위험이 있었음 (`cli-defs-plugin` 은 외부 입력을 거르지만 internal API 사용자가 직접 잘못된 source 를 만들면 silent 누설). `hasAccount` type-guard 자체도 NUL 차단으로 강화 (Codex-2 LOW + Claude-2 LOW 부분 합의). `stored.account` 의 NUL 포함도 자동 거부 → USER fallback 으로 controlled 동작. multi-account scope 누설 회귀 가드 +4건 (writeSource/readSource/sourceExists × 빈 문자열·NUL 매트릭스 + stored.account NUL fallback).

## [0.3.1] - 2026-05-26

ROADMAP universe 의 file-based 후보 builtin 확장 사이클. PR #25~#28 (4 builtin)
+ PR #31 (ROADMAP 정리). PR #29/#30 (Goose/Copilot) 은 quad-review 결과 mat 의
`KeychainSource.account` 필드 및 Linux Secret Service / Windows Credential
Manager source type 도입 후 재PR 예정으로 보류.

### Added

- **Kimi CLI 빌트인** — `BUILTIN_CLI_DEFS` 5번째 항목. `~/.kimi/config.toml` file source (saveAs `kimi.toml`). MoonshotAI 공식 Kimi Code CLI (https://github.com/MoonshotAI/kimi-cli) 의 단일 TOML credential 파일 swap. plugin 으로 'kimi' override 차단 회귀 가드 (`cli-defs.test.ts` + `cli-defs-plugin.test.ts`). README / ROADMAP 갱신 (지원 CLI 표 + 확장 universe).
- **Qwen Code CLI 빌트인** — `BUILTIN_CLI_DEFS` 6번째 항목. **multi-source** (`~/.qwen/settings.json` + `~/.qwen/.env`). Alibaba 공식 Qwen Code CLI (https://github.com/QwenLM/qwen-code, npm `@qwen-code/qwen-code`). Qwen 의 credential 우선순위 (shell export > `.env` > `~/.qwen/.env` > `settings.json` `env`) 때문에 `.env` 도 함께 swap — 그렇지 않으면 사용자가 `~/.qwen/.env` 사용 중 mat 가 settings.json 만 swap 해도 잘못된 계정으로 동작 가능 (PR #26 quad-review Codex MEDIUM 반영). Gemini multi-source 패턴 동일 — 부재 source 는 자동 skip. shell export 와 프로젝트 로컬 `.env` 는 mat scope 밖. plugin 으로 'qwen' override 차단 회귀 가드. ROADMAP universe 에서 Qwen 후보 → 빌트인 ✅ 로 이동.
- **Crush 빌트인** — `BUILTIN_CLI_DEFS` 7번째 항목. **multi-source** (`~/.config/crush/crush.json` + `~/.local/share/crush/crush.json`). Charm.sh 공식 Crush (https://github.com/charmbracelet/crush) 의 XDG 표준 경로 — 읽기 우선 config dir 와 API key 쓰기 대상 data dir 둘 다 swap 해야 일관 (한쪽만 swap 시 stale 위험). macOS / Linux 동일 경로 (Crush 가 XDG 사용, macOS native dir 미사용). plugin 으로 'crush' override 차단 회귀 가드. **mat scope 밖 한계** (PR #27 quad-review Codex HIGH 반영): cwd 의 `.crush.json` / `crush.json` (git root 까지 upward 탐색, project-local 우선순위 더 높음), workspace 의 `.crush/crush.json`, shell-exported provider env vars (`ANTHROPIC_API_KEY` 등), Crush 의 path override env vars (`CRUSH_GLOBAL_CONFIG` / `CRUSH_GLOBAL_DATA` / `XDG_CONFIG_HOME` / `XDG_DATA_HOME`) 는 모두 mat 의 home-단위 file swap 으로 제어 불가 — 사용자가 위 경로 중 하나를 활성 credential 으로 쓰고 있다면 mat swap 결과가 의도와 어긋날 수 있음. ROADMAP universe 에서 Crush 후보 → 빌트인 ✅ 로 이동.
- **OpenCode 빌트인** — `BUILTIN_CLI_DEFS` 8번째 항목. **단일 source** `~/.local/share/opencode/auth.json` (OS 공통). SST OpenCode (https://github.com/sst/opencode, MIT) 의 단일 JSON credential 파일 swap. provider ID 마다 `{ type: 'api', key: ... }` / OAuth 토큰 객체 저장 (권한 0o600). OpenCode 가 npm `xdg-basedir` 사용 → macOS / Linux / BSD / Windows 모두 동일 경로 (Apple Application Support 등 native 경로 분기 없음). plugin 으로 'opencode' override 차단 회귀 가드 + OS 4종 (darwin/linux/win32/freebsd) 모두 동일 경로 검증. **mat scope 밖 한계** (PR #28 quad-review Codex HIGH 반영): `XDG_DATA_HOME` env 설정 시 OpenCode 가 `$XDG_DATA_HOME/opencode/auth.json` 사용 → mat 의 기본 `~/.local/share` swap 무효 (wrong-account 위험). `OPENCODE_AUTH_CONTENT` env 시 파일 대신 env 내용 우선. `OPENCODE_CONFIG_DIR` 디렉토리 override 시 기본 경로 swap 무효. `OPENCODE_CONFIG` / `OPENCODE_CONFIG_CONTENT` 로 config 자체 주입 시 별도 provider 라우팅. 프로젝트 로컬 `opencode.json` / `opencode.jsonc` / `.opencode/opencode.json` + `.env` 도 provider env 참조 통해 credential 선택 영향 (cwd 기반은 mat scope 밖). config 내 `"{env:ANTHROPIC_API_KEY}"` env 참조 사용 시 shell env 가 실제 key 결정. ROADMAP universe 에서 OpenCode 후보 → 빌트인 ✅ 로 이동.

## [0.3.0] - 2026-05-24

### Added

- **Aider 빌트인** (`#22`) — `BUILTIN_CLI_DEFS` 4번째 항목. `~/.aider.conf.yml` file source (saveAs `aider.yml`). plugin 으로 'aider' override 차단 (builtin 우선 보안 정책). README plugin 예시는 비-builtin `my-cli` 템플릿으로 교체.
- **CLI def plugin loader** (`#14`) — `~/.multi-account-tool/cli-defs/*.json` 사용자 정의 CLI 지원. 신규 모듈 `src/core/cli-defs-plugin.ts` (`validateCliDefRaw` + `loadUserCliDefs`). 빌트인과 plugin id 충돌 시 빌트인 우선. 잘못된 plugin 은 warn + skip (mat 본체 정상 동작). `getAllCliDefs()` / `getCliDefsWarnings()` / `resetCliDefCache()` 헬퍼.
- **`describeError` helper** (`#16`) — TUI/CLI 에서 에러를 일관된 사용자 메시지로 surface. `KeychainAccountMissingError` 인 경우 raw service 명을 별도 라인으로 노출해 plugin/redact 우회 식별 가능. `cli.tsx` top-level + `app.tsx` `runBusyAction` catch 두 곳 적용.
- **`ValidationError` class** (`#17`) — `extends UsageError` 로 exitCode 2 자동 상속, `field` 명시. 입력 검증 실패 시 어떤 필드가 문제인지 호출자가 식별 가능.

### Changed

- **profile-store path traversal 자체 검증** (`#10`) — 9개 public 함수 모두 `cliId` / `name` / `fileName` 을 진입 즉시 자체 검증. `paths.ts` 의 path constructor 들도 동일 검증 수행 — 직접 호출 우회로도 traversal 불가능 (defense-in-depth).
- **NFC 디스크 표기 단일화** (`#10`) — 모든 프로필 디렉토리는 NFC 정규화된 이름으로 디스크 저장. NFD 입력도 `validateProfileName` 이 NFC 로 변환 후 path 구성. APFS (macOS 기본) 는 NFC 보존 → 사실상 무영향. HFS+/외부 fs 의 NFD 디렉토리만 수동 마이그레이션 필요.
- **validators 모듈 분리** (`#17`) — `paths.ts` (173줄, mixed-concern) → 87줄 (-93). validator 코드를 신규 `src/core/validators.ts` 로 추출. `paths.ts` re-export 로 호출자/테스트 변경 0건 (후방 호환).
- **migrate.ts `LEGACY_DATA_DIR` constant → function** (`#5`) — testability refactor. import 시점 HOME fix → 호출 시점 HOME 평가. production 동작 동일, 테스트의 setupTmpHome 격리와 정합.

### Fixed

- **createProfile partial-state 방지** (`#19`) — writeMeta 실패 (디스크 풀/권한 거부 등) 시 best-effort `fs.rm` rollback 추가. 이전: 디렉토리만 남는 부분 상태 가능. 새 버전: `renameProfile` 의 catch 분기와 동일 패턴 — 일관성 + 방어적 동작.
- **path traversal 방어 강화** (`#10`) — 이전 버전: `createProfile` / `renameProfile` 만 new name 검증, 나머지는 무방비. 새 버전: 모든 public 함수 + path constructor 가 입력 검증 → `../escape` / `foo/bar` / NUL 바이트 / 예약명 모두 차단.
- **keychain account 미파악 시 swap 거부** (`#10`) — `KeychainAccountMissingError` 도입. 이전: 미파악 시 무시하고 진행 → data loss 위험. 새 버전: throw + 호출자 분기 + `describeError` 로 안전한 사용자 메시지.
- **validator typeof string guard** (`#15`) — `validateCliId` / `validateProfileName` / `validateProfileFileName` 모두 runtime typeof 가드. Symbol / BigInt / Function 등 비-string 입력 거부 회귀 가드.

### Security

- **3-round quad-review 합의 13건 통합** (`#10`) — Claude + Codex + Antigravity + Forge 4트랙 8 워커가 traversal 가족 + keychain account 미파악을 종합 검토. R1 APPROVE 20% → R2 60% → R3 **100% 만장일치 수렴**.

### CI / Infrastructure

- **GitHub Actions CI** (`#3`) — macOS + ubuntu × node 20/22 = 4 조합 자동 검증. typecheck → vitest → build → check-publish. smoke-test 는 `continue-on-error` (CI 에 자격증명 없음). script injection 방지 (`github.event.*` 미사용, `env:` 추출).
- **npm Trusted Publishing (OIDC)** (`#3`) — tag `v*` push → `publish.yml` 이 OIDC 로 npm publish + `--provenance`. 토큰 관리 불필요. provenance attestation 자동 첨부.
- **Homebrew tap 자동 갱신** (`#13`) — `publish.yml` 에 `homebrew-tap` job 추가. `HOMEBREW_TAP_TOKEN` 시크릿 설정 시 동작 (Fine-grained PAT, homebrew-mat repo Contents=Read/Write). 미설정 시 skip notice 출력 후 정상 종료.

### Internal

- **테스트 인프라** (`#2`) — vitest 4 + `@vitest/coverage-v8` 도입. `tests/helpers/tmp-home.ts` 가 `$HOME` 격리. `vitest.config.ts` `pool: 'forks'` (concurrent worker HOME race 회피).
- **모듈별 단위 테스트 보강** (`#4`~`#9`) — quad-review 4트랙 합의 발견을 PR 마다 통합. 테스트 67 → 214 누적.
  - `#4`: quad-review single 발견 9건 (M/O/P/Q/R/V/W/L/K).
  - `#5`: cli-defs + detector + migrate (+26).
  - `#6`: config 모듈 (+19, atomic 0o600 + symlink scope).
  - `#7`: profile-store CRUD (+43, NFC/NFD round-trip).
  - `#8`: switcher snapshot/restore + 좀비 가드 (+15).
  - `#9`: sources file/keychain dual-branch + backup/rollback (+23).
- **PR #10 보안 강화 테스트** (`#10`) — 214 → 331 (+117). 9 public 함수 × 위험 입력 + path constructor 매트릭스.
- **테스트 정리** (`#12`) — `as never` cast ~28건 제거 (helper 1곳에 격리). `mockSpawn.mock.calls[N]` 매직 인덱스 5건 → `findSpawnCallsByArg` helper.
- **회귀 가드 보강** (`#15`, `#18`) — BAD_TYPES 매트릭스 확장 (Symbol/BigInt/Function), redact-before-truncate 순서 명문화 (`#15`), renameProfile rollback (corrupt meta.json 통합) + switcher 3-source 'tri-cli' fake def 주입 reverse-order rollback 검증 (`#18`).
- **profile-store.ts 100% lines + 100% branch** (`#19`) — listProfiles non-ENOENT (ENOTDIR) + readProfileFile non-ENOENT (EISDIR) real-fs 회귀 가드 + createProfile rollback (vi.doMock io-atomic, rollback 도 실패 swallow 분기 포함) + renameProfile `if(meta)` else 분기 (meta.json 누락) 커버. +5 테스트.
- **lockfile.ts 100% lines + 100% branch** (`#20`) — cross-process fork barrier 대신 단일 프로세스 결정론 (vi.doMock + real-fs chmod). readInfo typeof guard, pid=0 boundary, tryAcquire mkdir/handleConflict rename EACCES (chmod 0o500 + root-skip guard via `chmodActuallyDenies` helper), writeFileAtomic 실패 cleanup, rename ENOENT/ENOTEMPTY swallow + "반복된 race" fallback, fallback LockHeldError dead-pid 모두 회귀 가드. +8 테스트.
- **CHANGELOG.md 도입** (`#21`) — Keep a Changelog 1.1.0 형식. package.json `files` 에 명시. README / README.ko.md 에 Changelog 섹션 추가.
- **R3 quad-review LOW 정리** (`#11`) — JSDoc 4 + test 견고성 2.

## [0.2.0] - 2026-05-24

### Added

- **`mat exec <cli> <profile> -- <cmd...>`** (`#1`) — swap → 실행 → 종료 시 자동 원복. 시간 격리. lterm 즉시 통합 가능. Exit code: 0 성공 / 1 unexpected / 2 UsageError / 74 restore failed / 75 LockHeldError / 128+N 자식 시그널.
- **CLI 별 lockfile** (`src/core/lockfile.ts`) — mkdir-lock + owner token + atomic rename stale recovery. cli 별로 한 번에 하나의 `mat exec` 만 허용 (자격증명 손상 방지). POSIX mkdir atomicity 의존 (NFS 미지원, macOS/Linux 로컬 fs 전용).
- **Signal forwarder** — runExec 진입~finally hoist 로 race 4개 (등록 직전/swap 중/restore 중/release 중) 동시 해결.
- **`ExecResult.restoreError`** — cleanup 실패와 child 결과 분리 + 별도 exit code (74).
- **v0.1 데이터 디렉토리 자동 마이그레이션** (`src/core/migrate.ts`) — `~/.multi-sub-terminal/` → `~/.multi-account-tool/`. `multi-subscription-terminal` → `multi-account-tool` 이름 변경 (8310cf7).
- **TUI** — 여러 AI CLI (Claude Code / Codex / Gemini) 계정을 하나의 도구로 빠르게 전환. 프로필 단위 자격증명 보관 + 한 키스트로크 swap.
- **자격증명 source** — macOS Keychain (`security` CLI) + 파일 기반 모두 지원. backup → 정확 acct delete → add. add 실패 시 자동 롤백.
- **`writeFileAtomic` 공용 추출** — O_EXCL + O_NOFOLLOW + 0600 + rename. 모든 보안 쓰기 통일.
- **빌트인 CLI def**: `claude`, `codex`, `gemini`.

### Fixed

- **quad-review P0 4건** (`63e0dce`) — `mat exec` 의 lockfile race / restore error / cliId 검증 / signal scope.

### Security

- macOS Keychain 사용 시 `security` CLI `-w` argv 노출 (의도적 trade-off, README 명시).
- `-A` ACL 완화 (의도적 trade-off).
- 평문 backup (의도적 trade-off, age 암호화는 ROADMAP).

### Distribution

- **npm**: `multi-account-tool@0.2.0` — `npm install -g multi-account-tool`.
- **Homebrew**: `ictechgy/homebrew-mat` tap (mat.rb @ 0.2.0) — `brew tap ictechgy/mat && brew install mat`.
- **GitHub**: https://github.com/ictechgy/multi-account-tool

[Unreleased]: https://github.com/ictechgy/multi-account-tool/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/ictechgy/multi-account-tool/compare/v0.5.2...v0.6.0
[0.5.2]: https://github.com/ictechgy/multi-account-tool/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/ictechgy/multi-account-tool/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/ictechgy/multi-account-tool/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/ictechgy/multi-account-tool/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/ictechgy/multi-account-tool/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/ictechgy/multi-account-tool/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/ictechgy/multi-account-tool/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ictechgy/multi-account-tool/releases/tag/v0.2.0
