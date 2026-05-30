# 세션별 자격증명 격리 (Session-Scoped Credential Isolation) — 설계

- **날짜**: 2026-05-30
- **상태**: 승인됨 (브레인스토밍 합의 완료, 구현 계획은 ralplan 으로 별도 작성)
- **관련**: ROADMAP.md §2 (세션별 로그인 격리), §3 (lterm 과의 조화), HANDOFF.md "Round 3 #2"

---

## 1. 개요 / 목표

현재 mat 은 OS 전역으로 한 시점에 한 계정만 활성화한다. `mat exec` 은 lock 으로 직렬화된 **시간 격리**(전역 swap → 실행 → 원복)라, 두 터미널이 **동시에 다른 계정**을 쓸 수 없다.

이 기능은 **세션(프로세스 트리)별로 다른 계정을 동시에** 사용하게 한다. 메커니즘은 OS 전역 swap 이 아니라 **자식 프로세스에 env 주입** — 각 CLI 가 세션 전용 격리 디렉토리에서 자격증명을 읽도록 한다.

### 사용 시나리오
```bash
# 터미널 A
mat session start codex work       # CODEX_HOME=<세션A>/codex 인 subshell
codex                              # work 계정으로 실행

# 터미널 B (동시)
mat session start codex personal   # CODEX_HOME=<세션B>/codex 인 subshell
codex                              # personal 계정 — A 와 독립
```

### 비목표 (이번 iteration)
- env override 미지원 CLI (Gemini, Claude/macOS Keychain) 의 세션 격리 — 명시 에러로 안내.
- lterm 패키지 코드 변경 / shim wrapper (별도 후속, ROADMAP §3-C).
- TUI 통합 (CLI 명령만; TUI 는 후속).

---

## 2. 가능성 매트릭스 (조사 결과, document-specialist 2026-05-30)

| CLI | 격리 | env var | credential 포함 | 출처 |
|---|---|---|---|---|
| Codex | ✅ | `CODEX_HOME` (기본 `~/.codex`) | ✅ auth.json | developers.openai.com/codex/config-advanced |
| Qwen | ✅ | `QWEN_HOME` (기본 `~/.qwen`) | ✅ | github.com/QwenLM/qwen-code settings.md |
| Kimi | ✅ | `KIMI_SHARE_DIR` (기본 `~/.kimi`) | ✅ config.toml | kimi.com/code/docs env-variables |
| Crush | ✅ | `CRUSH_GLOBAL_CONFIG` + `CRUSH_GLOBAL_DATA` | ✅ (crush.json) | deepwiki charmbracelet/crush |
| Aider | ⚠️ | `AIDER_CONFIG` (config 만; key 는 provider env 직접) | ❌ | aider.chat/docs/config |
| OpenCode | ⚠️ | `XDG_DATA_HOME` (비공식, 검증필요) | 추측 | opencode.ai/docs/config |
| Gemini | ❌ | 없음 (Issue #2815 미구현) | — | github.com/google-gemini/gemini-cli#2815 |
| Claude | ❌ | keychain service env override 없음 (Linux 만 `CLAUDE_CONFIG_DIR`) | — | code.claude.com/docs/authentication |

**1차 구현 대상**: ✅ 4개 — **Codex / Qwen / Kimi / Crush**. 나머지는 미지원 명시(향후 재방문은 §10).

---

## 3. 아키텍처

### 3.1 신규 모듈 `src/core/session.ts`
`exec.ts` 의 패턴을 미러한다: 진입부 시그널 forwarder 등록 → 자원 확보 → 자식 spawn (stdio inherit) → settled-guard → `finally` 에서 재캡처/정리 → 시그널 재발생. 단 **전역 swap/lock 은 사용하지 않는다** (env 격리라 동시 실행 안전).

### 3.2 `CliDef.session` 메타데이터 (types.ts)
```ts
/** 세션 격리용 env-redirect 명세. 없으면 해당 CLI 는 세션 격리 미지원. */
export interface SessionSpec {
  /** env var → 그 var 가 override 하는 CLI 기본 base 디렉토리. 1개 이상. */
  roots: SessionRoot[];
}
export interface SessionRoot {
  /** 주입할 env var 이름 (예: 'CODEX_HOME'). */
  env: string;
  /** 이 env 가 재배치하는 CLI 의 기본 base 디렉토리 (예: '~/.codex'). source.path 의 상대경로 계산 기준. */
  base: string;
}
// CliDef 에 `session?: SessionSpec` 추가 (optional — backward compat).
```

빌트인 매핑:
```ts
codex:  { roots: [{ env: 'CODEX_HOME',          base: '~/.codex' }] }
qwen:   { roots: [{ env: 'QWEN_HOME',           base: '~/.qwen' }] }
kimi:   { roots: [{ env: 'KIMI_SHARE_DIR',      base: '~/.kimi' }] }
crush:  { roots: [{ env: 'CRUSH_GLOBAL_CONFIG', base: '~/.config/crush' },
                  { env: 'CRUSH_GLOBAL_DATA',   base: '~/.local/share/crush' }] }
```

### 3.3 paths.ts 추가
- `sessionsDir()` → `~/.multi-account-tool/sessions`
- `sessionDir(id)` → `~/.multi-account-tool/sessions/<id>` (id 검증: 영숫자/`-`/`_`)
- 세션 id 형식: `<cliId>-<profileName>-<rand8>` (NFC-safe; profileName 은 기존 validateProfileName 통과분만).

### 3.4 cli.tsx 디스패치
`first === 'session'` 분기 추가 → `handleSession(rest)` 가 `start|list|stop` 서브커맨드 라우팅. USAGE 갱신.

---

## 4. 자격증명 materialize — symlink-overlay (핵심 결정)

`<env>=<세션디렉토리>` 로 바꾸면 CLI 는 그 디렉토리 **전체**를 읽는다. mat 이 관리하는 건 자격증명 파일뿐이므로, 비-secret config(예: Codex `config.toml`)를 CLI 가 못 찾는 문제가 있다.

**채택: symlink-overlay.** 각 root 의 세션 하위 디렉토리를 다음과 같이 구성한다:
1. 실제 base 디렉토리(`~/.codex` 등)가 존재하면, 그 안의 **모든 엔트리를 세션 디렉토리로 symlink** 한다.
2. **단, mat 이 관리하는 자격증명 파일**(해당 root 에 속한 `FileSource` 들의 base-상대 경로)은 symlink 하지 않고, **프로필에서 복사한 실제 격리본(0600)**으로 둔다.
3. `<env>` 를 세션 하위 디렉토리로 set 한 subshell 을 spawn.

효과:
- 비-secret config(`config.toml`, memory, skills 등) → symlink 로 **공유**(읽기/쓰기 모두 실제 파일에 반영).
- 자격증명 파일 → 계정별 **격리**(in-session 쓰기는 격리본에만).

종료 시:
- 격리본 자격증명 파일을 **프로필로 재캡처**(OAuth refresh rotation 보존 — `mat exec` 와 동형 정책).
- 세션 디렉토리(symlink + 격리본) 삭제. 실제 base 는 무손상.

base 가 없으면(fresh): symlink 없이 격리본 자격증명만 둔 세션 디렉토리 생성.

### 4.1 source ↔ root 매핑 규칙
각 `FileSource.path`(expandTilde 후)가 어느 root 의 `base` 하위인지 prefix 매칭 → 상대경로 = `path - base`. 세션 내 격리본 위치 = `<세션디렉토리>/<env별 하위>/<상대경로>`.
- 시작 시 검증: session-capable CLI 의 모든 source 는 `type==='file'` 이고 정확히 한 root 의 base 하위여야 한다. 아니면 명시 에러(설정 결함 방지).

---

## 5. 라이프사이클

### 5.1 `mat session start <cli> <profile>`
1. 인자/존재 검증: cliId 유효, `CliDef.session` 존재(없으면 미지원 에러), profile 존재, profile 에 자격증명 파일 존재.
2. 세션 id 생성 + `sessionDir(id)` 0700 생성.
3. `session.json` 기록: `{ id, cli, profile, pid: <자식 아님, 본 mat 프로세스 pid>, startedAt, roots: [{env, dir}] }`.
4. 각 root materialize (symlink-overlay, §4).
5. 시그널 forwarder 등록(SIGINT/SIGTERM/SIGHUP).
6. subshell spawn: `process.env.SHELL || '/bin/sh'`, stdio inherit, env = `{...process.env, ...rootEnvs, MAT_SESSION=id}`. (셸 미경유 spawn — argv 배열.)
7. 자식 종료 대기 (settled-guard 로 error/exit race 보호).
8. `finally`:
   a. 재캡처: 각 격리본 자격증명 파일을 프로필로 copy (timeout 가드 — `mat exec` 의 `MAT_EXEC_RECAPTURE_TIMEOUT_MS` 패턴 재사용 또는 동형 신규).
   b. 세션 디렉토리 삭제(symlink 는 대상 미파괴로 안전 삭제 — `fs.rm` 은 symlink 자체만 제거).
   c. lock/forwarder 해제.
9. 자식 종료 코드/시그널 전파(cli.tsx 가 재발생).

### 5.2 `mat session list`
`sessionsDir()` 스캔 → 각 `session.json` 읽기 → `pid` liveness 확인(`process.kill(pid, 0)`) → 살아있으면 active, 죽었으면 orphan 표시. cli/profile/startedAt/상태 테이블 출력.

### 5.3 `mat session stop <id>` + orphan 정리
- `stop <id>`: 해당 세션의 pid 에 SIGTERM(살아있으면) → 정상 종료 시 위 finally 가 정리. 이미 죽었으면 orphan 정리 경로.
- orphan 정리: pid 죽음 + (선택) startedAt TTL 초과 세션 디렉토리를 회수 — **자격증명 재캡처 없이 삭제**(라이브를 신뢰할 수 없으므로; lockfile stale-recovery 의 "warn + drop" 정책 미러). 회수 시 사용자에게 경고(어느 세션이 비정상 종료됐는지 + 프로필은 마지막 정상 재캡처 상태).
- orphan 정리 트리거: `mat session list`/`stop`/`start` 진입 시 best-effort 스캔(과도한 자동 삭제 방지 위해 TTL 보수적).

---

## 6. 전역 swap / exec / lock 과의 상호작용
- 세션 격리는 **실제 base 디렉토리의 자격증명 파일을 건드리지 않는다**(symlink + 격리본). 따라서 전역 활성 자격증명, `config.json` 의 active map, `mat exec` 의 cli lock 과 **무간섭** → 동시 실행 안전.
- 단, **같은 base 의 비-secret 파일은 symlink 공유**라 세션과 전역이 동시에 같은 config 파일을 쓰면 일반적인 동시 쓰기 race 가 가능(자격증명은 아님). 문서에 명시(비-secret 한정, 자격증명 격리는 보장).

## 7. 에러 처리 / 엣지 케이스
- `CliDef.session` 부재 CLI → "이 CLI 는 세션 격리 미지원: <이유 요약>. (env override 미지원)" 명시 에러.
- profile 자격증명 파일 부재 → "프로필에 캡처된 자격증명이 없습니다" 에러(start 중단, 세션 디렉토리 생성 전).
- 자식 SIGKILL → finally/handler 미실행 → 세션 디렉토리 orphan 잔류 → 다음 `mat session` 의 orphan 정리가 회수(§5.3). 한계 명시(`mat exec` 와 동일).
- symlink 생성 중 대상 충돌/권한 → 부분 생성 롤백(생성한 세션 디렉토리 제거) 후 에러.
- 재캡처 timeout/실패 → 경고 후 세션 디렉토리는 정리, 별도 exit code 로 자동화에 신호(`mat exec` restoreError 매핑 미러).

## 8. 보안 고려
- 격리본 자격증명 파일은 `writeFileAtomic`(0600 + O_NOFOLLOW) 또는 동형으로 생성, 세션 디렉토리 0700.
- symlink-overlay: 자격증명 파일은 **절대 symlink 아님**(격리본). 비-secret 만 symlink. base readdir 시 자격증명 saveAs 대상은 제외.
- env 값은 디렉토리 경로(비밀 아님) → argv/env 노출 무해. 자격증명은 파일로만 전달(env 에 토큰 안 실음).
- 세션 id / profile / cli 는 기존 validator 로 path traversal 차단.
- orphan 정리 삭제는 `sessionsDir()` 하위로 한정 + id 검증(광역 삭제 방지).

## 9. 테스트 전략 (TDD)
- **단위**: SessionSpec source↔root 매핑/상대경로 계산, materialize 가 자격증명만 격리본·나머지 symlink 인지(임시 HOME fixture), 재캡처가 격리본→프로필 복사인지, orphan 판정(pid liveness mock), 미지원 CLI 에러, source 비-file/미커버 검증 에러.
- **통합**: 가짜 CLI 스크립트(자격증명 파일을 읽고 새 값으로 rewrite)로 start→subshell(non-interactive 명령)→재캡처 라운드트립. 동시 2세션이 서로 다른 격리본을 보는지.
- 기존 cli-defs.test 에 빌트인 4개 `session` 메타 회귀 가드.
- macOS 개발 + CI ubuntu 양쪽 동작(파일/symlink 만 — secret-tool 무관).

## 10. 범위 밖 / 향후
- **Gemini**: Issue #2815 구현 시 재방문. 현재 `HOME`/symlink 우회는 side-effect 위험으로 채택 안 함.
- **Claude**: macOS keychain service env override 부재 → 세션 격리 불가 명시. Linux 는 `CLAUDE_CONFIG_DIR` 가능성 별도 R&D.
- **Aider**: `AIDER_CONFIG`(config) + provider env(key) — env-export 흐름(별도 설계).
- **OpenCode**: `XDG_DATA_HOME` auth.json 재배치 실측 검증 후 추가.
- **lterm shim** (`lterm <cli> --profile`), **TUI 세션 패널**, **`mat session env`(eval 출력)** — 후속.

## 11. CLI 표면 요약
```
mat session start <cli> <profile>   # 격리 subshell spawn (primary)
mat session list                    # 실행 중/orphan 세션 목록
mat session stop <id>               # 세션 종료(SIGTERM) 또는 orphan 정리
```
