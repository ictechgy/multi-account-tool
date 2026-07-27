# 자격증명 경로 별칭(symlink/hardlink) 우회 — 실측 감사

_작성: 2026-07-27 · 대상 빌드: v0.8.2 (main = `871a722`)_

이 문서는 v0.8.3 의 근거가 된 **실측 결과**를 기록한다. 과거 감사 문서는 소급 수정하지 않는다.

---

## 1. 측정 방법

`os.tmpdir()` 아래에 mkdtemp 로 임시 HOME 을 만들고 `realpath` 로 해석한 뒤 `process.env.HOME`
으로 지정했다(macOS 의 `/var/folders/...` 는 `/private/var/folders/...` 로의 symlink 라 미해석
경로를 HOME 으로 쓰면 이후 판정이 무의미해진다). 그 HOME 에 **진짜 자격증명 파일**
`~/.codex/auth.json` (내용 `REAL-CODEX-TOKEN`) 을 두고, 빌드된 `dist/core/*.js` 를 직접 import
해서 `getAllCliDefs()` / `readSource` / `writeSource` 를 호출했다.

---

## 2. v0.8.2 에서 뚫려 있던 것

### 2.1 소유권 가드 — 별칭 표기

| 별칭 형태 | plugin 로드 | `readSource` 가 실제 토큰 반환 | `writeSource` 가 실제 파일 훼손 |
|---|---|---|---|
| 디렉토리 symlink `~/aliasdir` → `~/.codex`, 선언 `~/aliasdir/auth.json` | 통과 | **반환함** | **훼손함** |
| 파일 symlink `~/aliasfile.json` → `~/.codex/auth.json` | 통과 | **반환함** | 안 함 |
| hardlink `~/hard.json` = `~/.codex/auth.json` | 통과 | **반환함** | 안 함 |

쓰기가 두 경우에 막힌 것은 `io-atomic.ts` 가 tmp 를 `O_EXCL|O_NOFOLLOW` 로 열고 rename 하기
때문이지 소유권 판정 덕분이 **아니다**. 세 경우 모두 읽기는 통과했다 — 즉 **읽기가 보편적
유출 채널**이었다.

### 2.2 goose 예약구역 — 두 가지 형태

예약구역(`classifyGoosePath`)은 "builtin 이 지금 쓰는 7+2 경로" 보다 **넓다**. 그래서 소유권
검사로는 잡히지 않고, 구역 판정 자체가 어휘적이라 두 형태로 뚫렸다:

1. **별칭 표기** — `~/gsalias` → `~/.config/goose/newprovider` 를 만들고 plugin 이
   `~/gsalias/tokens.json` 을 선언 → 어휘 분류 `'outside'` → **로드 통과**.
2. **해석된 정경 표기** — `~/.config` 를 `~/dotfiles/config` 로 관리하는 사용자에게 진짜 구역은
   `~/dotfiles/config/goose/` 다. plugin 이 그 경로를 **직접** 선언하면 어휘 분류는 `'outside'`
   이지만 실제로는 구역 한복판이다.

(2) 때문에 대상 경로만 해석해서는 닫히지 않는다 — 이미 해석형이라 해석해도 그대로다.
**구역 루트도 함께 해석**해서 비교해야 한다.

---

## 3. 범위 결정의 핵심 입력 — 정직한 사용자가 이미 깨져 있었다

v0.8.1 의 goose 하드닝은 조상 symlink 를 거부한다. 이 방식을 다른 builtin 으로 확대하는 안을
검토하다가 다음을 실측했다:

- `~/.config` → `~/dotfiles/config` 로 dotfiles 를 관리하는 사용자는 **v0.8.2 시점에 이미**
  goose provider 캐시가 `unsafe Goose provider cache parent` 로 막혀 있었다.
- 같은 파일을 `~/goosealias/tokens.json` 로 부르면 어휘 멤버십이 빗나가 **하드닝이 아예 발동하지
  않고** 토큰을 반환했다.

즉 그 거부는 **정직한 사용자만 막고 공격자는 못 막았다.** 확대했다면 codex·claude·gemini·
kimi·grok 까지 같은 상태가 되어 도구 자체를 못 쓰게 된다. 그래서 축을 **거부 → 해석 후 동일성
비교**로 틀었다.

---

## 4. 성능 실측 (판정 비용)

| 항목 | 측정값 |
|---|---|
| builtin 파일 리소스 20 개 해석 1-pass | **0.088 ms** |
| 같은 경로에 있는 keychain `security` 스폰 1 회 | **31.9 ms** |

판정 결과를 프로세스 수명 동안 캐시하지 **않는다** — 캐시하면 캐시 시점 이후의 별칭을 놓쳐
I/O 시점 게이트의 존재 이유가 사라진다. 위 비용이면 캐시할 이유도 없다.

---

## 5. 수정 후 재측정

| 항목 | 결과 |
|---|---|
| 별칭 5종(디렉토리·파일 symlink, hardlink, 부재 대상 별칭, 정경) 로드 | 전부 거부 |
| 대소문자 변형 | 파일시스템이 대소문자를 **접을 때** 거부 (case-sensitive 볼륨에서는 서로 다른 경로이므로 통과가 정답이며, 테스트가 실제 파일시스템 속성을 프로브해 분기한다) |
| 로드 **이후** 생긴 별칭에 대한 read/write/exists/remove | 4/4 거부, 실제 토큰 불변 |
| 거부 메시지 | 고정 문자열 — HOME·해석 경로·선언 표기 미포함 |
| dotfiles 사용자의 goose provider 파일 read/write | **성공** (v0.8.2 에서는 실패했다) |
| dotfiles 사용자의 goose provider 디렉토리 source | **성공** |
| 비-private 조상 (0777) | 계속 거부 |
| goose 예약구역 별칭 2형태 | 전부 거부 |
| 구역 밖 dotfiles plugin | 통과 (과잉 거부 없음) |

Red evidence — 각 수정을 되돌렸을 때 신규 테스트(2 파일 30 건)의 실패 수:

| 되돌린 축 | 실패 |
|---|---|
| 소유권을 어휘 판정으로 | 4 |
| I/O 시점 게이트 무력화 | 3 |
| goose 완화 되돌리기(미해석 HOME + `expandTilde`) | 3 |
| 예약구역 어휘 판정으로 | 2 |
| `reserve` 를 어휘 키만 등록하도록 | 2 |
| Gate 2 면제를 해석 키까지 인정하도록 | 1 |
| leaf 까지 해석하도록 | 2 |
| 구역 루트 해석 실패를 거부로 (가용성 회귀 재현) | 1 |

리뷰 6 라운드에서 확정·수정한 결함은 15 건이고 그중 **6 건은 이 변경 자체가 만든 것**이다
(leaf symlink 추종, 등록 경로 분기, 구역 루트 fail-open, 그 fail-open 을 닫으려다 생긴 가용성
회귀, 새 sentinel 의 롤백 집계 누락, 해석 실패의 HOME 경계 오기재). 반대로 에이전트 주장 12 건은
실측으로 반증해 기각했다 — 합의 3 트랙짜리 주장도 포함된다.

---

## 6. 닫히지 않은 것

- **HOME 밖으로 나가는 dotfiles** — 부모 walk 기준선이 HOME 이라 `/Volumes/ext/config` 류는
  계속 거부된다.
- **group-writable 조상** — umask 002 로 goose 가 만든 0775 디렉토리는 v0.8.0 부터의 진단 그대로.
- **goose 외 builtin 의 무결성 하드닝** — 별칭 *선언* 은 막지만 정경 경로 조상의 실행 중 교체는
  미방어.
- **구역 루트를 해석할 수 없는 상태** — 그때는 구역 판정이 어휘 결과로 되돌아간다. 거부하도록
  했더니 예약구역과 무관한 파일 I/O 까지 막혀서(실측) 되돌렸다. 흔한 실패 원인(경로를 따라
  내려가다 만난 EACCES/ELOOP)에서는 구역 안 경로도 함께 해석 불가라 실질 노출이 없지만,
  bind mount 처럼 구역으로 가는 경로가 둘 이상이면 성립하지 않는다 — **증명이 아니라 판단**이다.
- **일반 파일의 resolve→open 잔여 경합** — Node 에 `openat`/dirfd 가 없어 원리적으로 닫을 수
  없다. goose 경로만 부모 dev/ino pinning 과 단계별 재확인으로 **탐지**한다.
- **plugin 없이 성립하는 조상 교체** — 정직한 `~/.codex → ~/dotfiles/codex` 와 악의적
  `~/.codex → ~/attacker` 는 파일시스템 형상이 **완전히 동일**해 무상태 술어로 구별 불가능하다.
  비용이 아니라 **범주** 문제이므로 향후 스윕으로 닫히지 않는다 — 자격증명 루트 identity 원장
  같은 상태 기반 설계가 필요하다. 또한 같은 UID 공격자에게는 cron·shell rc·watcher 같은 더 싸고
  확실한 수단이 이미 있다.
