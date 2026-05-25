# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/ictechgy/multi-account-tool/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ictechgy/multi-account-tool/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ictechgy/multi-account-tool/releases/tag/v0.2.0
