# 세션별 자격증명 격리 (Session-Scoped Credential Isolation) — 설계

- **날짜**: 2026-05-30
- **상태**: 승인됨 (브레인스토밍 합의 + ralplan consensus iter-1 반영 — materialize 를 copy-isolate 로 개정)
- **관련**: ROADMAP.md §2 (세션별 로그인 격리, 원안=자격증명 **복사**), §3 (lterm 조화), HANDOFF.md "Round 3 #2"

> **개정 이력**: 최초 설계는 symlink-overlay 였으나 ralplan consensus(Architect CONCERNS + Critic ITERATE)가 코드 근거로 결함 4건을 입증 — (1) Qwen/Kimi 자격증명·config 혼재로 공유 이점 무효, (2) io-atomic 이 symlink-safe 아님, (3) 무차별 symlink=fail-open, (4) 비-secret 쓰기 공유로 "전역 무간섭" 거짓. → **copy-isolate(기본) + 명시 allow-list symlink(read-mostly config 만)** 로 전환.
>
> **개정 이력 2 (issue #72, 2026-06-02)**: allow-list 도 **symlink → copy-isolate(0600 복사)** 로 전환. 실측으로 codex `config.toml` 이 read-mostly 가 아님을 확인 — `codex mcp add`/`plugin add` 등이 `[mcp_servers.*]` 같은 authority-bearing 설정을 config.toml 에 **실제로 기록**한다. symlink 공유였다면 세션 내 그 명령이 base `~/.codex/config.toml` 을 변경(write-back)해 세션 격리가 깨지고 동시 세션끼리 간섭했다. 복사로 전환해 세션 수정은 격리본에만 남고 종료 시 폐기되며 재캡처(creds 전용) 대상이 아니라 **write-back 이 구조적으로 제거**된다(§6.1 한계 해소). 읽기는 `O_NOFOLLOW` 로 열어 lstat→read TOCTOU 도 막는다.

---

## 1. 개요 / 목표

현재 mat 은 OS 전역으로 한 시점에 한 계정만 활성화한다. `mat exec` 은 lock 으로 직렬화된 **시간 격리**라, 두 터미널이 **동시에 다른 계정**을 쓸 수 없다.

이 기능은 **세션(프로세스 트리)별로 다른 계정을 동시에** 사용하게 한다. 메커니즘은 OS 전역 swap 이 아니라 **자식 프로세스에 env 주입** — 각 CLI 가 세션 전용 격리 디렉토리에서 자격증명을 읽도록 한다.

### 사용 시나리오
```bash
# 터미널 A
mat session start codex work       # CODEX_HOME=<세션A>/codex 인 subshell
codex                              # work 계정으로 실행
# 터미널 B (동시)
mat session start codex personal   # CODEX_HOME=<세션B>/codex — A 와 독립
```

### 비목표 (이번 iteration)
- env override 미지원 CLI (Claude/macOS Keychain, Aider, Goose, Google Antigravity/`agy`) 세션 격리 — 명시 에러.
- lterm 패키지 코드 변경 / shim wrapper (후속, ROADMAP §3-C).
- TUI 통합 (CLI 명령만).
- 비-secret config 의 세션↔전역 **양방향 실시간 동기화** (allow-list 의 좁은 공유만; 그 외 비-secret 은 세션 내 ephemeral).

---

## 2. 가능성 매트릭스 (조사 결과, document-specialist 2026-05-30)

> **개정 이력 3 (2026-06-03)**: Gemini/Claude 확대. **Gemini** = 소스 실측(gemini-cli 0.41
> `homedir()`=`GEMINI_CLI_HOME`, `getGlobalGeminiDir()`=`join(homedir(),'.gemini')`)로 `GEMINI_CLI_HOME`
> 이 `.gemini` 의 **부모**임을 PR-G0 게이트로 확정 → `SessionRoot.envSubdir='.gemini'` 도입(env 가
> base 부모를 가리키는 CLI 지원, 단일 세그먼트 강제). **Claude** = platform-split: Linux 는
> `~/.claude/.credentials.json`(file, base 직속)을 `CLAUDE_CONFIG_DIR` 로 격리(✅), macOS 는 keychain
> 이라 env 디렉토리 리다이렉트로 격리 불가(planSession 명시 throw, ❌). settings.json 은 자격증명+config
> 혼재라 share 제외(세션 ephemeral). Aider 는 계속 BLOCKED, OpenCode 는 EXPERIMENTAL 로 확대(XDG_DATA_HOME broad side effect). 근거:
> `.omc/research/pr-g0-gemini-cli-home-gate.md`.
>
> **개정 이력 5 (2026-06-11)**: Google Antigravity CLI(`agy`)는 Gemini CLI 와 분리해 BLOCKED 로 명시. 공식 문서는 OS native keyring(Apple Keychain / Linux Secret Service/dbus / Windows Credential Manager) 인증을 설명하고, 설정/cache 는 `~/.gemini/antigravity-cli/` 하위에 둔다. 로컬 agy 1.0.7 안전 실측에서 `GEMINI_CLI_HOME`, XDG env, `ANTIGRAVITY_EXECUTABLE_DATA_DIR` 는 app-data 를 재배치하지 못했고 broad `HOME` 만 영향을 줬다. 0600 `antigravity-oauth-token` 파일이 관찰될 수 있어도 안정 문서화된 token-store/keyring 계약과 CLI 전용 redirect 전에는 부분 auth 격리를 금지한다.

| CLI | 격리 | env var | credential 포함 |
|---|---|---|---|
| Codex | ✅ | `CODEX_HOME` (기본 `~/.codex`) | ✅ auth.json (config.toml 은 별도) |
| Qwen | ✅ | `QWEN_HOME` (기본 `~/.qwen`) | ✅ settings.json + .env (config 혼재) |
| Kimi | ✅ | `KIMI_SHARE_DIR` (기본 `~/.kimi`) | ✅ config.toml (config 혼재) |
| Crush | ✅ | `CRUSH_GLOBAL_CONFIG` + `CRUSH_GLOBAL_DATA` | ✅ crush.json ×2 |
| Gemini CLI | ✅ | `GEMINI_CLI_HOME` (envSubdir `.gemini`) | ✅ oauth_creds.json + google_accounts.json |
| Google Antigravity (`agy`) | ❌ blocked | 없음 (`HOME` 만 app-data 에 영향, 너무 광범위) | ❌ 공식 keyring auth + 미문서/불안정 파일 token-store |
| Claude | ⚠️ linux | `CLAUDE_CONFIG_DIR` (기본 `~/.claude`) | ✅ .credentials.json (macOS=keychain ❌) |
| Aider | ⚠️ | `AIDER_CONFIG` (config 만) | ❌ (key=provider env) |
| OpenCode | ⚠️ experimental | `XDG_DATA_HOME` + envSubdir `opencode` | ✅ auth.json (broad XDG side effect) |

**1차 구현 대상**: ✅ 4개 — **Codex / Qwen / Kimi / Crush**. **개정 3**: + **Gemini**(envSubdir) / **Claude linux**(file). **개정 4**: + **OpenCode EXPERIMENTAL**(`XDG_DATA_HOME` broad env; 다른 XDG 도구 data/credential 이 ephemeral 세션 dir 로 들어가 종료 시 사라질 수 있음). macOS Claude·Aider·Goose·Google Antigravity(`agy`) 는 미지원/범위 밖.

---

## 3. 아키텍처

### 3.1 신규 모듈 `src/core/session.ts`
`exec.ts` 패턴 미러: 진입부 시그널 forwarder → 자원 확보 → 자식 spawn(stdio inherit) → settled-guard → `finally` 재캡처/정리 → 시그널 재발생. **전역 swap/lock 미사용**(env 격리라 동시 안전).

### 3.2 `CliDef.session` 메타데이터 (types.ts)
```ts
export interface SessionSpec { roots: SessionRoot[]; }
export interface SessionShareDir {
  rel: string;         // base 기준 단일 세그먼트 directory root (예: 'skills')
  maxBytes?: number;   // optional; planSession 이 기본값으로 정규화
  maxFiles?: number;
  maxEntries?: number; // file + directory 전체 항목 수 상한
  maxDepth?: number;
}
export interface SessionRoot {
  env: string;          // 주입할 env var (예: 'CODEX_HOME')
  base: string;         // 이 env 가 재배치하는 CLI 기본 base (예: '~/.codex')
  envSubdir?: string;   // env 가 base 의 부모를 가리킬 때의 단일 하위 세그먼트 (예: Gemini '.gemini')
  warning?: string;     // broad env 사용 시 session start stderr 경고
  share?: string[];     // 단일 파일 allow-list: 0600 copy-isolate, write-back 없음
  shareDirs?: SessionShareDir[]; // directory allow-list: 재귀 copy-isolate, write-back 없음
}
// CliDef 에 `session?: SessionSpec` 추가 (optional — backward compat).
```
빌트인 매핑(요약):
```ts
codex:  { roots: [{ env: 'CODEX_HOME', base: '~/.codex', share: ['config.toml'], shareDirs: [{ rel: 'skills' }] }] }
qwen:   { roots: [{ env: 'QWEN_HOME', base: '~/.qwen' }] }       // 혼재 → 공유 없음
kimi:   { roots: [{ env: 'KIMI_SHARE_DIR', base: '~/.kimi' }] }  // 혼재 → 공유 없음
crush:  { roots: [{ env: 'CRUSH_GLOBAL_CONFIG', base: '~/.config/crush' },
                  { env: 'CRUSH_GLOBAL_DATA',   base: '~/.local/share/crush' }] }
gemini: { roots: [{ env: 'GEMINI_CLI_HOME', base: '~/.gemini', envSubdir: '.gemini' }] }
claude: { roots: [{ env: 'CLAUDE_CONFIG_DIR', base: '~/.claude' }] } // Linux file-source only
opencode: { roots: [{ env: 'XDG_DATA_HOME', base: '~/.local/share/opencode', envSubdir: 'opencode', warning: '...' }] }
```
`session` 없는 CLI → `mat session start` 시 미지원 명시 에러.

### 3.3 paths.ts
- `sessionsDir()` → `~/.multi-account-tool/sessions`, `sessionDir(id)` → 그 하위. id 검증(영숫자/`-`/`_`).
- 세션 id: `<cliId>-<profileName>-<rand8>` (NFC-safe).

### 3.4 cli.tsx
`first === 'session'` → `handleSession(rest)` 가 `start|list|stop` 라우팅. **`handleSession` 은 종료코드를 return** (process.exit 은 호출부) — 단위 테스트 가능(M4). USAGE 갱신.

---

## 4. 자격증명 materialize — copy-isolate + allow-list (핵심 결정, 개정됨)

`<env>=<세션디렉토리>` 로 바꾸면 CLI 는 그 디렉토리 전체를 읽는다. mat 이 **세션 디렉토리를 직접 새로 생성**하고 그 안을 다음과 같이 채운다:

1. **자격증명 파일 (항상 격리 복사)**: 해당 root 에 속한 `FileSource` 들을, 프로필에 저장된 값으로 세션 디렉토리 내 네이티브 상대경로에 **복사**(`writeFileAtomic`, 0600). 세션 디렉토리는 우리가 만든 fresh 경로라 path 에 symlink 가 없어 io-atomic 안전 전제가 성립.
2. **allow-list config (0600 복사 — copy-isolate, #72)**: `SessionRoot.share` 의 각 항목만 실제 base 에서 세션 디렉토리로 **복사**(`writeFileAtomic`, 0600). 생성 전 (a) 세션 측 경로 부모가 실제 디렉토리인지 `lstat` 검증, (b) 실제 base 측 대상이 symlink 가 아닌지 `lstat` 검증(symlink 면 거부, `config.ts:122` 선례) + 읽기는 `O_NOFOLLOW`. 세션 수정은 격리본에만 남아 base write-back 없음(이전 symlink 공유 폐기).
3. **allow-list directory (재귀 복사 — copy-isolate)**: `SessionRoot.shareDirs` 의 각 top-level 디렉토리만 실제 base 에서 세션 디렉토리로 **재귀 복사**한다. 현재 Codex `skills/` 전용. root 는 단일 세그먼트만 허용하고, 하위 항목은 regular file/directory 만 허용한다. symlink/hardlink/special file, traversal, maxDepth/maxFiles/maxEntries/maxBytes 초과는 fail-closed. 세션 내 skill 수정은 격리본에만 남고 write-back/재캡처 없음.
4. **그 외 base 내용**: **materialize 하지 않는다**(fail-closed). CLI 는 격리 디렉토리에서 해당 파일을 못 찾으면 자체 기본값을 쓰거나 새로 만든다(세션 내 ephemeral, 종료 시 폐기).
5. `<env>` 를 세션 디렉토리로 set 한 subshell spawn.

**효과**: 자격증명=계정별 격리(실제 base 무관), read-mostly config(Codex `config.toml`)와 Codex `skills/`=copy-isolate(시작 시점 재현·write-back 없음), 미지/휘발성(history/sessions/DB)=세션 내 ephemeral(공유 안 함 → 동시 쓰기 손상 0). 모르는 항목은 공유 안 함 = **fail-closed**.

### 4.1 source ↔ root 매핑 + 직속 제약
- 각 `FileSource.path`(expandTilde 후)가 어느 root 의 `base` **직속**(rel = `relative(base,path)` 에 path 구분자 `/` 없음)인지 검증. 비직속(`subdir/x`)·비-file·미커버 source → `planSession` 이 **명시 에러**(추측 금지).
- 4 CLI 자격증명은 모두 base 직속(`auth.json`/`settings.json`/`.env`/`config.toml`/`crush.json`)이라 1차 충족. 디렉토리 내부 자격증명은 follow-up.

### 4.2 io-atomic 안전성 (개정 — "미러"가 아니라 신규 보장)
`writeFileAtomic` 의 `O_NOFOLLOW` 는 tmp 열기에만 적용되고 `rename(tmp,path)`·`mkdir(dirname)` 은 symlink-safe 가 아니다. copy-isolate 는 **자격증명과 allow-list config/dir 를 우리가 만든 fresh 세션 디렉토리(절대 symlink 아님)에만** 쓰므로 이 위험을 회피한다. allow-list 파일 복사는 base 원본을 `O_NOFOLLOW` 로 읽고(마지막 컴포넌트 symlink swap 차단) 부모 realpath 봉쇄로 escape 를 막은 뒤 `writeFileAtomic` 로 쓴다. allow-list 디렉토리 복사는 root/하위 symlink 를 거부하고 regular file 은 `O_NOFOLLOW` 로 열며 용량·파일수·항목수·깊이 제한을 적용한다. 세션 디렉토리 생성·복사 경로에 대해 부모 `lstat` 검증을 명시한다.

---

## 5. 라이프사이클

### 5.1 `mat session start <cli> <profile>`
1. 검증: cliId 유효, `CliDef.session` 존재(없으면 미지원 에러), profile 존재 + 자격증명 파일 존재. `planSession` 이 source↔root 매핑·직속 제약 검증(§4.1) — 실패 시 세션 디렉토리 생성 전 중단.
2. `SessionPlan`(시작시점 고정 매핑: root별 env/dir, 자격증명 rel 목록, allow-list 파일/디렉토리) 산출. 시작·종료가 동일 매핑을 쓰도록 고정(매핑 drift 차단).
3. `sessionDir(id)` 0700 생성 + `session.json` 기록: `{ id, cli, profile, pid(본 mat 프로세스), startedAt, roots:[{env,dir}] }`.
4. materialize(§4): 자격증명 복사 + allow-list 파일/디렉토리 복사(copy-isolate, #72). 부분 실패 시 생성한 세션 디렉토리 롤백(rm) 후 에러.
5. 시그널 forwarder 등록.
6. subshell spawn: `process.env.SHELL || '/bin/sh'`, stdio inherit, env=`{...process.env, ...rootEnvs, MAT_SESSION=id}` (argv 배열, 셸 미경유).
7. 자식 종료 대기(settled-guard).
8. `finally`:
   a. **재캡처(2-phase commit)**: 각 root 자격증명 격리본 → 프로필. **multi-cred(Qwen/Crush) 는 ① 전 cred 새 값을 프로필 옆 staging 파일에 먼저 쓰고(라이브 무변경) ② 전부 stage 성공 후 일괄 commit(rename)** 한다. preflight 에서 프로필 현재값 백업, 부분 commit 실패는 **compare-and-restore** 롤백(현재 디스크값이 우리가 commit 한 값일 때만 원복/삭제 — 동시 같은-프로필 세션의 commit 을 clobber 하지 않음, PR #61 2회차). stage(byte-write) 만 `withTimeout`(liveness) 으로 감싸고, **commit(rename) 은 감싸지 않는다** — rename 은 취소 불가라 timeout 후 late-landing 하면 committed 에 없어 롤백에서 빠져 split 을 남긴다(PR #61 2회차 Codex/Forge). 완료/예외까지 기다려 롤백을 정확히 한다. `MAT_EXEC_RECAPTURE_TIMEOUT_MS` 는 `mat exec` 와 공유(`timeout.ts` 단일 출처). split 윈도우는 catastrophic-fs rename 한정.
   b. 세션 디렉토리 삭제(allow-list config 격리본도 일반 파일이라 `fs.rm` 으로 함께 제거 — base 무손상, write-back 없음).
   c. forwarder 해제.
9. 자식 종료 코드/시그널 전파.

### 5.2 `mat session list`
`sessionsDir()` 스캔 → 각 `session.json` → pid liveness(`isProcessAlive`, lockfile.ts **재사용**) → active/orphan 표기 테이블.

### 5.3 `mat session stop <id>` + orphan 정리
- 소유 신원은 **tri-state `classifyOwner`** 로 판정(PR #61 2회차 Forge): `owner`(살아있고 서명 일치 또는 옛 메타 liveness-only) / `dead-or-reused`(죽음 또는 서명 불일치=pid 재사용) / `unknown`(서명 기록돼 있으나 `ps` 조회 실패로 확정 불가). 시작 서명 `pidStart`=`ps -o lstart`(LC_ALL=C·TZ=UTC 고정 — locale/TZ 비결정성 제거).
- `stop <id>`: `owner` 일 때만 SIGTERM(정상 종료 → finally 정리). `dead-or-reused` 면 디렉토리만 정리. **`unknown` 이면 신호도 삭제도 하지 않는다**(소유 mat 이 살아있으면 wrong-kill·라이브 디렉토리 삭제 위험 → 경고 후 보존). 단일 boolean 을 stop=kill/reap=delete 정반대 바이어스에 쓰지 않기 위해 3-state 분리.
- orphan: **`dead-or-reused` AND startedAt TTL 초과 AND 디렉토리 mtime TTL 초과** 세션만 회수 — 재캡처 없이 삭제(라이브 불신뢰, lockfile "warn+drop" 미러). **TTL 1h**(M2). `owner`/`unknown` 은 보존(잘못 삭제 방지). `sessionsDir()` 하위 + id 검증 한정(광역삭제 차단).
- 트리거: `list/stop/start` 진입 시 best-effort.

---

## 6. 전역 swap / exec / lock 과의 상호작용
- 자격증명은 **세션 격리본에만** 존재 → 실제 base 자격증명, `config.json` active map, `mat exec` cli lock 과 **무간섭**(자격증명 충돌 0).
- **allow-list config(Codex `config.toml`)도 copy-isolate(0600 복사, issue #72)** → 세션 시작 시점 설정은 재현하되, 세션 내 수정(`codex mcp add`/`plugin add` 가 `[mcp_servers.*]` 를 실제로 기록)은 격리본에만 남고 base 로 write-back 되지 않는다. **세션/전역 동시 쓰기 race 0**(이전 symlink 공유의 이론상 race 해소). 그 외 비-secret 은 세션 내 ephemeral 이라 공유 race 없음.

### 6.1 동시 **같은-프로필** 세션 재캡처 — 프로필 단위 락으로 해소 (issue #62)
본 기능은 **터미널마다 서로 다른 프로필**을 쓰는 것이 설계 전제다(§1). 같은 cli·**같은 프로필**을 두 터미널에서 동시에 띄우는 경우(= 같은 계정)는 **프로필 단위 best-effort advisory 락**(`acquireRecaptureLock`, `lockfile.ts`)으로 해소한다:
- **양쪽 세션이 모두 락 획득에 성공하면** 종료 재캡처의 backup-read→commit→rollback **전체가 직렬화**돼, multi-cred(Qwen/Crush) 의 cred 단위 interleave 로 cred 별 winner 가 갈리던 **split-by-generation 을 제거**한다(최종 두 cred 가 단일 세션의 일관 세대). compare-and-restore 가 cred 별 독립이라 흡수하지 못하던 cross-cred 비일관을 락 직렬화가 막는다(test 15 가드).
- 락은 `mat exec` cli-lock 과 **별도 namespace**(`locks/recapture/<cli>/<profile>.lock`)라 exec 와 충돌하지 않는다. stale-판정 로직은 exec `handleConflict` 와 `probeHolder`/`reclaimStaleLock` **단일 출처를 공유**한다(§8 M3 충실).
- **mid-acquire 윈도우 보호**: live holder 의 mkdir↔info.json write 마이크로초 윈도우는 `probeHolder` 의 `INFLIGHT_WRITE_WAIT_MS`(200ms) 재확인이 보호해, 살아있는 holder 를 stale 로 오판해 reclaim 하는 double-held 손상을 막는다.
- **best-effort 범위 (무조건 직렬화 아님)**: 한쪽이라도 deadline(`RECAPTURE_LOCK_WAIT_MS`=5s) 초과/mkdir 권한오류로 락 획득에 실패하면 그 구간은 **문서화된 lock-free 2-phase commit 으로 degrade**(경고 1회)한다. 정상 경합은 holder 가 ms-scale(소형 cred byte-write, 무네트워크 — 측정 전 코드추론 근거, follow-up 으로 통합 측정)이라 폴백이 사실상 없어 거의 항상 직렬화되지만, **무조건 직렬화를 보장하지는 않는다**.
- **위험 범위 (폴백 구간)**: 폴백 시에도 모두 **같은 계정** 내 토큰 세대 불일치이지 **wrong-account 노출이 아니다**. 최악도 한쪽 cred 가 stale → 다음 CLI 사용 시 refresh/re-auth 로 자가 치유. 단일-cred CLI(codex/kimi)는 락 없이도 결정적 last-writer-wins 라 양쪽 모두 유효.
- **SIGKILL 누수**: 락 보유 중 SIGKILL 되면 락 디렉토리가 잔존하나, 다음 실행이 stale 회수한다(exec orphan 과 동일 한계).
- `classifyOwner='unknown'`(서명 조회 영구 실패) 세션은 stop/reap 이 보존만 한다 → ps 가 항구적으로 불능인 비현실적 환경에선 orphan 이 남을 수 있다. 수동 삭제(`rm` 세션 디렉토리) 또는 pid 종료로 해소. auto-force-delete 는 라이브 세션 오삭제 위험이 커 도입하지 않음.

## 7. 에러 처리 / 엣지
- `session` 부재 CLI → "세션 격리 미지원(env override 미지원): <이유>" 에러.
- profile 자격증명 부재 → "캡처된 자격증명 없음" 에러(세션 생성 전).
- 비직속/비-file/미커버 source → `planSession` 명시 에러(§4.1).
- allow-list 대상이 base 에 symlink 거나 부모가 symlink → 거부 에러(§4.2).
- SIGKILL → finally 미실행 → orphan 잔류 → 다음 `mat session` orphan 정리 회수(§5.3). 한계 명시.
- 재캡처 timeout/실패 → 경고 + 별도 exit code(자동화 신호, `mat exec` restoreError 매핑 미러). multi-cred 부분 실패는 롤백(M1).

## 8. 보안
- 격리본 자격증명: `writeFileAtomic`(0600+O_NOFOLLOW) — fresh 세션 디렉토리(non-symlink) 에만 쓰기. 세션 디렉토리 0700.
- allow-list 복사(copy-isolate, #72): base 대상이 symlink 면 거부(`config.ts:122` 선례, fail-closed) + 읽기 `O_NOFOLLOW` + 부모 realpath 봉쇄. 격리본은 0600. base write-back 없음(세션 수정은 격리본에만).
- env 값=디렉토리 경로(비밀 아님) → argv/env 노출 무해. 토큰은 파일로만.
- 세션 id/profile/cli 기존 validator 로 traversal 차단. orphan 삭제는 `sessionsDir()` 하위 한정.
- `isProcessAlive`/`sanitizeForStderr` 는 lockfile.ts 에서 **export 재사용**(또는 `process-util.ts` 추출) — 동형 재구현 금지(보안 로직 분기 방지, M3).
- 프로필 단위 재캡처 락(issue #62)의 stale-판정·회수도 cli-lock(`handleConflict`)과 `probeHolder`/`reclaimStaleLock` **단일 출처를 공유**한다(동형 재구현·재배열 금지, M3). exec 호출부는 default(`throw LockHeldError`), 재캡처는 live holder 시 폴링하도록 옵션 콜백으로만 분기해 exec 런타임 동작을 보존한다.

## 9. 테스트 전략 (TDD)
- **단위**: source↔root 매핑/직속 제약 에러, materialize 가 자격증명=복사·allow-list=복사(copy-isolate, write-back 격리 가드 포함)·그외=부재 인지(임시 HOME), allow-list 복사 거부(symlink 대상/부모), 재캡처 multi-cred 원자성+롤백(부분 실패 시 split 안 됨), orphan 판정(pid liveness + TTL mock), `handleSession` 종료코드 반환, 미지원 CLI 에러.
- **통합(명시 PR 산출물)**: 가짜 CLI 스크립트(자격증명 읽고 rewrite)로 start→subshell(non-interactive)→재캡처 라운드트립. **동시 2세션이 서로 다른 격리본을 보는지** + 두 세션이 base 비-secret 을 건드리지 않는지(ephemeral 확인).
- cli-defs.test 에 빌트인 4개 `session` 메타 회귀 가드. macOS + CI ubuntu 양쪽(파일/symlink 만 — secret-tool 무관).

## 10. 범위 밖 / 향후
macOS Claude(keychain env 부재), Aider(env-export/redirect 부재), Goose(keychain/os-keyring), Google Antigravity(`agy`: native keyring + 안정 credential redirect 부재), OpenCode upstream `OPENCODE_DATA_DIR` 추적(현재 XDG experimental), Crush data root 비-secret 공유 확대, lterm shim, TUI 패널, `mat session env`(eval). Crush `~/.local/share/crush/` 의 DB/캐시 구조는 공유 확대 전 실측 필요.

## 11. CLI 표면
```
mat session start <cli> <profile>   # 격리 subshell spawn (primary)
mat session list                    # 실행 중/orphan 목록
mat session stop <id>               # 종료(SIGTERM) 또는 orphan 정리
```

## 12. ADR
- **Decision**: 세션 격리를 env 주입 + **copy-isolate(자격증명 + allow-list config/dir 복사)** 로 구현. 자격증명은 항상 격리 복사, 종료 시 원자적 재캡처. allow-list config/dir 는 시작 시점 복사만 하고 write-back/재캡처 없음(issue #72 — 최초엔 symlink 였으나 codex 의 config.toml write-back 실측으로 복사 전환; Codex `skills/` 는 별도 `shareDirs` 로 재귀 복사).
- **Drivers**: (1) 자격증명 손실/오염 방지(최우선), (2) 전역/`mat exec` 무간섭, (3) 동시 다계정, (4) 기존 패턴 재사용·단순성.
- **Alternatives**: symlink-overlay(io-atomic 비안전+fail-open+혼재 CLI 무효 → 기각), 전체 copy-isolate(allow-list 없이 — config 공유 0, 단순하나 Codex config 휘발; allow-list 가 이를 좁게 보완), env-only(자격증명 파일 못 다룸 → 기각).
- **Why**: copy-isolate 는 fail-closed·io-atomic 부담 소거를 공짜로 얻고, 사용자 1차 요구(자격증명 격리, ROADMAP 원안=copy)와 정합. allow-list 가 분리형 config(Codex) 공유 이점을 좁고 안전하게 회복.
- **Consequences**: (+) 자격증명·allow-list config/skills 무간섭 보장, 동시 다계정, 동시쓰기 손상 0(copy-isolate 로 allow-list 공유 race 도 제거 — #72). (−) allow-list 외 비-secret 은 세션 내 ephemeral, allow-list config/skills 의 세션 내 수정은 base 에 반영되지 않음(write-back 없음 — 영구 변경은 세션 밖에서).
- **Follow-ups**: Crush data 비-secret 공유 확대(실측 후), macOS Claude/Aider/Goose/Google Antigravity, OpenCode `OPENCODE_DATA_DIR` upstream 추적, lterm shim, TUI. Antigravity unblock 조건은 (1) `AGY_HOME`/`ANTIGRAVITY_CONFIG_HOME` 같은 CLI 전용 credential redirect, 또는 (2) 문서화된 token-store 경로와 플랫폼별 keyring service/account 계약, 또는 (3) 안전한 비파괴 테스트로 검증 가능한 upstream auth relocation 계약.
