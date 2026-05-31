# 세션별 자격증명 격리 (Session-Scoped Credential Isolation) — 설계

- **날짜**: 2026-05-30
- **상태**: 승인됨 (브레인스토밍 합의 + ralplan consensus iter-1 반영 — materialize 를 copy-isolate 로 개정)
- **관련**: ROADMAP.md §2 (세션별 로그인 격리, 원안=자격증명 **복사**), §3 (lterm 조화), HANDOFF.md "Round 3 #2"

> **개정 이력**: 최초 설계는 symlink-overlay 였으나 ralplan consensus(Architect CONCERNS + Critic ITERATE)가 코드 근거로 결함 4건을 입증 — (1) Qwen/Kimi 자격증명·config 혼재로 공유 이점 무효, (2) io-atomic 이 symlink-safe 아님, (3) 무차별 symlink=fail-open, (4) 비-secret 쓰기 공유로 "전역 무간섭" 거짓. → **copy-isolate(기본) + 명시 allow-list symlink(read-mostly config 만)** 로 전환.

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
- env override 미지원 CLI (Gemini, Claude/macOS Keychain) 세션 격리 — 명시 에러.
- lterm 패키지 코드 변경 / shim wrapper (후속, ROADMAP §3-C).
- TUI 통합 (CLI 명령만).
- 비-secret config 의 세션↔전역 **양방향 실시간 동기화** (allow-list 의 좁은 공유만; 그 외 비-secret 은 세션 내 ephemeral).

---

## 2. 가능성 매트릭스 (조사 결과, document-specialist 2026-05-30)

| CLI | 격리 | env var | credential 포함 |
|---|---|---|---|
| Codex | ✅ | `CODEX_HOME` (기본 `~/.codex`) | ✅ auth.json (config.toml 은 별도) |
| Qwen | ✅ | `QWEN_HOME` (기본 `~/.qwen`) | ✅ settings.json + .env (config 혼재) |
| Kimi | ✅ | `KIMI_SHARE_DIR` (기본 `~/.kimi`) | ✅ config.toml (config 혼재) |
| Crush | ✅ | `CRUSH_GLOBAL_CONFIG` + `CRUSH_GLOBAL_DATA` | ✅ crush.json ×2 |
| Aider | ⚠️ | `AIDER_CONFIG` (config 만) | ❌ (key=provider env) |
| OpenCode | ⚠️ | `XDG_DATA_HOME` (비공식) | 추측 |
| Gemini | ❌ | 없음 (Issue #2815) | — |
| Claude | ❌ | keychain service env override 없음 | — |

**1차 구현 대상**: ✅ 4개 — **Codex / Qwen / Kimi / Crush**.

---

## 3. 아키텍처

### 3.1 신규 모듈 `src/core/session.ts`
`exec.ts` 패턴 미러: 진입부 시그널 forwarder → 자원 확보 → 자식 spawn(stdio inherit) → settled-guard → `finally` 재캡처/정리 → 시그널 재발생. **전역 swap/lock 미사용**(env 격리라 동시 안전).

### 3.2 `CliDef.session` 메타데이터 (types.ts)
```ts
export interface SessionSpec { roots: SessionRoot[]; }
export interface SessionRoot {
  env: string;        // 주입할 env var (예: 'CODEX_HOME')
  base: string;       // 이 env 가 재배치하는 CLI 기본 base (예: '~/.codex') — source.path 상대경로 기준
  share?: string[];   // 명시 allow-list: 실제 base 와 symlink 공유할 read-mostly 비-secret config (base 상대경로). 자격증명은 절대 불포함.
}
// CliDef 에 `session?: SessionSpec` 추가 (optional — backward compat).
```
빌트인 매핑 — **1차 구현은 전 CLI `share` 생략(=∅)** (M-A, fail-closed). codex `config.toml`
은 OAuth state 포함 여부 미검증이라 follow-up 으로 켠다 (켜기 전에 `validateShareRel` +
materialize 양측 경로 봉쇄 검증을 이미 구현해 둠 — PR #61):
```ts
codex:  { roots: [{ env: 'CODEX_HOME', base: '~/.codex' }] }     // share 후보 config.toml — follow-up
qwen:   { roots: [{ env: 'QWEN_HOME', base: '~/.qwen' }] }       // 혼재 → 공유 없음
kimi:   { roots: [{ env: 'KIMI_SHARE_DIR', base: '~/.kimi' }] }  // 혼재 → 공유 없음
crush:  { roots: [{ env: 'CRUSH_GLOBAL_CONFIG', base: '~/.config/crush' },
                  { env: 'CRUSH_GLOBAL_DATA',   base: '~/.local/share/crush' }] } // 1차 보수적 공유 없음
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
2. **allow-list config (symlink 공유)**: `SessionRoot.share` 의 각 항목만 실제 base 의 해당 파일로 symlink. 생성 전 (a) 세션 측 경로 부모가 실제 디렉토리인지 `lstat` 검증, (b) 실제 base 측 대상이 symlink 가 아닌지 `lstat` 검증(symlink 면 거부, `config.ts:122` 선례). read-mostly 라 동시쓰기 위험 낮음.
3. **그 외 base 내용**: **materialize 하지 않는다**(fail-closed). CLI 는 격리 디렉토리에서 해당 파일을 못 찾으면 자체 기본값을 쓰거나 새로 만든다(세션 내 ephemeral, 종료 시 폐기).
4. `<env>` 를 세션 디렉토리로 set 한 subshell spawn.

**효과**: 자격증명=계정별 격리(실제 base 무관), read-mostly config(Codex `config.toml`)=공유, 미지/휘발성(history/sessions/DB)=세션 내 ephemeral(공유 안 함 → 동시 쓰기 손상 0). 모르는 항목은 공유 안 함 = **fail-closed**.

### 4.1 source ↔ root 매핑 + 직속 제약
- 각 `FileSource.path`(expandTilde 후)가 어느 root 의 `base` **직속**(rel = `relative(base,path)` 에 path 구분자 `/` 없음)인지 검증. 비직속(`subdir/x`)·비-file·미커버 source → `planSession` 이 **명시 에러**(추측 금지).
- 4 CLI 자격증명은 모두 base 직속(`auth.json`/`settings.json`/`.env`/`config.toml`/`crush.json`)이라 1차 충족. 디렉토리 내부 자격증명은 follow-up.

### 4.2 io-atomic 안전성 (개정 — "미러"가 아니라 신규 보장)
`writeFileAtomic` 의 `O_NOFOLLOW` 는 tmp 열기에만 적용되고 `rename(tmp,path)`·`mkdir(dirname)` 은 symlink-safe 가 아니다. copy-isolate 는 **자격증명을 우리가 만든 fresh 세션 디렉토리(절대 symlink 아님)에만** 쓰므로 이 위험을 회피한다. 세션 디렉토리 생성·allow-list symlink 생성 경로에 대해 부모 `lstat` 검증을 명시한다.

---

## 5. 라이프사이클

### 5.1 `mat session start <cli> <profile>`
1. 검증: cliId 유효, `CliDef.session` 존재(없으면 미지원 에러), profile 존재 + 자격증명 파일 존재. `planSession` 이 source↔root 매핑·직속 제약 검증(§4.1) — 실패 시 세션 디렉토리 생성 전 중단.
2. `SessionPlan`(시작시점 고정 매핑: root별 env/dir, 자격증명 rel 목록, allow-list) 산출. 시작·종료가 동일 매핑을 쓰도록 고정(매핑 drift 차단).
3. `sessionDir(id)` 0700 생성 + `session.json` 기록: `{ id, cli, profile, pid(본 mat 프로세스), startedAt, roots:[{env,dir}] }`.
4. materialize(§4): 자격증명 복사 + allow-list symlink. 부분 실패 시 생성한 세션 디렉토리 롤백(rm) 후 에러.
5. 시그널 forwarder 등록.
6. subshell spawn: `process.env.SHELL || '/bin/sh'`, stdio inherit, env=`{...process.env, ...rootEnvs, MAT_SESSION=id}` (argv 배열, 셸 미경유).
7. 자식 종료 대기(settled-guard).
8. `finally`:
   a. **재캡처(2-phase commit)**: 각 root 자격증명 격리본 → 프로필. **multi-cred(Qwen/Crush) 는 ① 전 cred 새 값을 프로필 옆 staging 파일에 먼저 쓰고(라이브 무변경) ② 전부 stage 성공 후 일괄 commit(rename)** 한다. preflight 에서 프로필 현재값 백업, 부분 commit 실패는 backup 으로 역순 롤백(없던 cred 는 삭제). 단순 per-cred `Promise.race` timeout 은 hung write 를 취소하지 못해 timeout 후 late-landing 시 split 이 재발생하므로(PR #61 Codex H1), staging 으로 split 윈도우를 byte-write 전체에서 rename 으로 축소(catastrophic fs 한정). timeout 가드(`MAT_EXEC_RECAPTURE_TIMEOUT_MS` **재사용**, 신규 env 도입 안 함)는 liveness 보호용으로 각 단계에 유지.
   b. 세션 디렉토리 삭제(symlink 는 `fs.rm` 이 링크 자체만 제거 — 대상 base 무손상).
   c. forwarder 해제.
9. 자식 종료 코드/시그널 전파.

### 5.2 `mat session list`
`sessionsDir()` 스캔 → 각 `session.json` → pid liveness(`isProcessAlive`, lockfile.ts **재사용**) → active/orphan 표기 테이블.

### 5.3 `mat session stop <id>` + orphan 정리
- `stop <id>`: **소유 mat 생존 시에만** SIGTERM(정상 종료 → finally 정리). 살아있어도 시작 서명(`pidStart`=`ps -o lstart`) 불일치 = pid 재사용 → SIGTERM 생략 + 디렉토리 정리(무관 프로세스 오kill 방지, PR #61 Codex H2). 죽었으면 orphan 정리.
- orphan: **소유 프로세스 사망 AND startedAt TTL 초과 AND 디렉토리 mtime TTL 초과** 세션을 회수 — 재캡처 없이 삭제(라이브 불신뢰, lockfile "warn+drop" 미러). **TTL 1h**(M2). "소유 프로세스 사망" 은 pid liveness + 시작 서명까지 보아, pid 재사용으로 살아있어 보이는 stale 세션도 회수(서명 불일치 시). 서명 미기록(옛 메타)/ps 미지원이면 liveness-only 보수 폴백. `sessionsDir()` 하위 + id 검증 한정(광역삭제 차단).
- 트리거: `list/stop/start` 진입 시 best-effort.

---

## 6. 전역 swap / exec / lock 과의 상호작용
- 자격증명은 **세션 격리본에만** 존재 → 실제 base 자격증명, `config.json` active map, `mat exec` cli lock 과 **무간섭**(자격증명 충돌 0).
- 단, **allow-list 로 symlink 공유한 read-mostly config(Codex `config.toml`)는 실제 base 와 공유** → 그 파일에 한해 세션/전역 동시 쓰기 race 가 이론상 가능(자격증명 아님, read-mostly 라 위험 낮음). 명시 한계. 그 외 비-secret 은 세션 내 ephemeral 이라 공유 race 없음.

## 7. 에러 처리 / 엣지
- `session` 부재 CLI → "세션 격리 미지원(env override 미지원): <이유>" 에러.
- profile 자격증명 부재 → "캡처된 자격증명 없음" 에러(세션 생성 전).
- 비직속/비-file/미커버 source → `planSession` 명시 에러(§4.1).
- allow-list 대상이 base 에 symlink 거나 부모가 symlink → 거부 에러(§4.2).
- SIGKILL → finally 미실행 → orphan 잔류 → 다음 `mat session` orphan 정리 회수(§5.3). 한계 명시.
- 재캡처 timeout/실패 → 경고 + 별도 exit code(자동화 신호, `mat exec` restoreError 매핑 미러). multi-cred 부분 실패는 롤백(M1).

## 8. 보안
- 격리본 자격증명: `writeFileAtomic`(0600+O_NOFOLLOW) — fresh 세션 디렉토리(non-symlink) 에만 쓰기. 세션 디렉토리 0700.
- allow-list symlink: 대상이 symlink 면 거부(`config.ts:122` 선례, fail-closed). 자격증명은 절대 symlink 아님.
- env 값=디렉토리 경로(비밀 아님) → argv/env 노출 무해. 토큰은 파일로만.
- 세션 id/profile/cli 기존 validator 로 traversal 차단. orphan 삭제는 `sessionsDir()` 하위 한정.
- `isProcessAlive`/`sanitizeForStderr` 는 lockfile.ts 에서 **export 재사용**(또는 `process-util.ts` 추출) — 동형 재구현 금지(보안 로직 분기 방지, M3).

## 9. 테스트 전략 (TDD)
- **단위**: source↔root 매핑/직속 제약 에러, materialize 가 자격증명=복사·allow-list=symlink·그외=부재 인지(임시 HOME), allow-list symlink 거부(symlink 대상/부모), 재캡처 multi-cred 원자성+롤백(부분 실패 시 split 안 됨), orphan 판정(pid liveness + TTL mock), `handleSession` 종료코드 반환, 미지원 CLI 에러.
- **통합(명시 PR 산출물)**: 가짜 CLI 스크립트(자격증명 읽고 rewrite)로 start→subshell(non-interactive)→재캡처 라운드트립. **동시 2세션이 서로 다른 격리본을 보는지** + 두 세션이 base 비-secret 을 건드리지 않는지(ephemeral 확인).
- cli-defs.test 에 빌트인 4개 `session` 메타 회귀 가드. macOS + CI ubuntu 양쪽(파일/symlink 만 — secret-tool 무관).

## 10. 범위 밖 / 향후
Gemini(Issue #2815), Claude(keychain env 부재), Aider(env-export), OpenCode(XDG 실측), Crush data root 비-secret 공유 확대, lterm shim, TUI 패널, `mat session env`(eval). Crush `~/.local/share/crush/` 의 DB/캐시 구조는 공유 확대 전 실측 필요.

## 11. CLI 표면
```
mat session start <cli> <profile>   # 격리 subshell spawn (primary)
mat session list                    # 실행 중/orphan 목록
mat session stop <id>               # 종료(SIGTERM) 또는 orphan 정리
```

## 12. ADR
- **Decision**: 세션 격리를 env 주입 + **copy-isolate(기본) + allow-list symlink(read-mostly config)** 로 구현. 자격증명은 항상 격리 복사, 종료 시 원자적 재캡처.
- **Drivers**: (1) 자격증명 손실/오염 방지(최우선), (2) 전역/`mat exec` 무간섭, (3) 동시 다계정, (4) 기존 패턴 재사용·단순성.
- **Alternatives**: symlink-overlay(io-atomic 비안전+fail-open+혼재 CLI 무효 → 기각), 전체 copy-isolate(allow-list 없이 — config 공유 0, 단순하나 Codex config 휘발; allow-list 가 이를 좁게 보완), env-only(자격증명 파일 못 다룸 → 기각).
- **Why**: copy-isolate 는 fail-closed·io-atomic 부담 소거를 공짜로 얻고, 사용자 1차 요구(자격증명 격리, ROADMAP 원안=copy)와 정합. allow-list 가 분리형 config(Codex) 공유 이점을 좁고 안전하게 회복.
- **Consequences**: (+) 자격증명 무간섭 보장, 동시 다계정, 동시쓰기 손상 0(allow-list 외). (−) allow-list 외 비-secret 은 세션 내 ephemeral, allow-list 파일은 좁은 공유 race 가능(read-mostly).
- **Follow-ups**: Crush data 비-secret 공유 확대(실측 후), Gemini/Claude/Aider/OpenCode, lterm shim, TUI.
