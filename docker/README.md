# Linux keyring 개발/테스트 환경 (docker)

macOS 개발 머신에서 **Linux Secret Service(`secret-tool`)** 에 의존하는
OS keyring source type(`os-keyring`) 작업을 개발/검증하기 위한 컨테이너 환경.

> 배경: PR-3b 이후(`secret-tool search/clear/store` 실제 구현)는 Linux 전용
> `secret-tool` 에 의존해 macOS 세션에서 진행할 수 없었다. 이 환경이 그 제약을
> 해소한다. plan: [`../.omc/plans/os-keyring-source-type.md`](../.omc/plans/os-keyring-source-type.md).

## 구성

| 파일 | 역할 |
| --- | --- |
| `Dockerfile` | `ubuntu:24.04`(CI ubuntu-latest 와 일치) + node 20 + `libsecret-tools`/`gnome-keyring`/`dbus-x11`. 비-root(`ubuntu`) 실행. |
| `keyring-entrypoint.sh` | dbus 세션 기동 → 빈 password 로 login keyring 생성/unlock → daemon ready polling → 명령 실행. |
| `run.sh` | 이미지 빌드 + 프로젝트 bind-mount + `node_modules` named volume 격리 후 명령 실행. |

## 사용법

```bash
# 대화형 셸 (keyring 활성 상태로 진입)
docker/run.sh

# 의존성 설치 — node_modules named volume 에 1회 필요 (호스트와 분리됨)
docker/run.sh npm ci

# 전체 테스트 (Linux + secret-tool 환경에서 697 tests 검증됨)
docker/run.sh npm test

# 실 keyring round-trip e2e (plan §196 hard gate / §197 account-recovery gap)
docker/run.sh bash scripts/secret-tool-e2e.sh

# mock fixture 파생용 실측 출력 캡처 (PR-3b 구현 시)
docker/run.sh bash scripts/secret-tool-e2e.sh --capture tests/fixtures/os-keyring
```

> `node_modules` 는 macOS(arm64-darwin) ↔ 컨테이너(arm64-linux) 네이티브 바이너리
> 충돌을 피하려고 named volume(`mat_node_modules`)에 격리한다. 호스트의
> `node_modules` 와 섞이지 않으므로 컨테이너에서 한 번 `npm ci` 가 필요하다.

## ⚠️ 실측한 `secret-tool` 시맨틱 (plan 가정과의 차이)

`scripts/secret-tool-e2e.sh` 7/7 PASS 로 확정한 사실
(libsecret-tools **0.21.4** / gnome-keyring **46.1**, ubuntu:24.04).
**PR-3b 파서는 plan §120/F2 가 아니라 아래 실측을 기준으로 구현해야 한다.**

| 항목 | plan 가정 | **실측** |
| --- | --- | --- |
| `search --all` 출력 채널 | 전부 `stderr` | block-header `[/N]`·`label`·**`secret`** 은 **stdout** / `attribute.<key>` 은 **stderr** (분리) |
| 매칭 N 카운트 소스 | stderr | **stdout** 의 `^\[/` 헤더 출현 횟수 (`[/N]` 의 숫자는 item ID 일 뿐 카운트 아님) |
| 부재(없음) 판정 | `exit code != 0` | **`exit 0` + 빈 출력** — exit code 로 부재 판정 불가 |
| secret 누설(F4) 모델 | secret 이 attribute 와 같은 stderr 버퍼에 co-locate | secret=stdout, attribute=stderr **분리** (그래도 parse-failure error 에 raw output 미포함 정책은 유효) |
| `clear` 시맨틱(Scenario 4) | 매칭 전부 삭제 | ✅ 확정 — service-only(N=2) clear → 0 남음. **clear 전 N=1 검증 필수** |
| `store` 시맨틱 | add(중복 실패 → delete 먼저) | **upsert/덮어쓰기** — 동일 `(service,account)` 재store 시 block 1, 최신값 |
| N>1 collision 발생 조건 | — | `(service,account)` 2-attr 조회는 항상 0/1. **service-only 조회에서만 N>1** |
| stdout↔stderr 블록 순서 | — | 두 채널이 **같은 순회 순서** (stdout N번째 블록 ↔ stderr N번째 attribute set) |
| 미설치 | — | shell 127 → Node `spawn` 에선 `error` 이벤트(ENOENT). daemon-down 은 별도 D-Bus 에러 |

### headless unlock 의 핵심 (재현 메모)
- login keyring 이 없으면 `store` 가 GUI 프롬프트를 띄우려다 `collection/login does not exist` 로 실패한다. **빈 password(`printf '\n'`)로 `gnome-keyring-daemon --unlock` 하면 login keyring 이 자동 생성**된다.
- `--unlock`/`--start` 의 출력(`GNOME_KEYRING_CONTROL`/`SSH_AUTH_SOCK`)을 **eval 해야** `secret-tool` 이 같은 daemon 에 연결된다.
- unlock 직후 곧장 `store` 하면 `locked collection` 레이스가 난다 → **ready polling**(store probe 성공까지) 필요.
