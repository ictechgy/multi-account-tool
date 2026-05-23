# multi-subscription-terminal (`mat`)

여러 AI CLI 계정(Claude Code, Codex, Gemini / Antigravity)을 **하나의 TUI에서 빠르게 전환**해 사용하는 도구.
매번 `logout` → `login` 반복할 필요 없이 프로필 단위로 자격증명을 보관하고 한 번에 갈아끼울 수 있다.

```
╭ Multi-Subscription Terminal ────────────────────────╮
│  AI CLI 계정 스위처                                  │
╰──────────────────────────────────────────────────────╯

  > Claude Code      [활성: personal] ✓
    Codex CLI        [활성: work]     ✓
    Gemini / Antigravity [활성: personal] ✓
```

---

## 왜 만들었나

- Claude Code, Codex, Gemini 등 여러 AI CLI를 동시에 쓰는데 각 CLI마다 계정이 여러 개일 때
- 매번 `logout` / `login` 반복하는 게 귀찮을 때
- "지금 어느 계정에 로그인돼 있더라?" 헷갈릴 때

---

## 어떻게 동작하나

`mat`은 각 CLI의 **자격증명만 정밀하게 swap**한다.
디렉토리 통째로 교체하지 않기 때문에, `hooks/`, `agents/`, `CLAUDE.md` 같은 사용자 설정은 그대로 유지된다.

| CLI | 자격증명 위치 | 보관 방식 |
| --- | --- | --- |
| Claude Code | macOS Keychain (`Claude Code-credentials`) | Keychain 항목 swap |
| Codex CLI | `~/.codex/auth.json` | 파일 swap |
| Gemini / Antigravity | `~/.gemini/oauth_creds.json`, `google_accounts.json` | 파일 swap |

### 전환 흐름 (데이터 손실 없음)

1. 현재 라이브 자격증명을 **현재 활성 프로필**에 자동 스냅샷 (= 백업)
2. 선택한 프로필의 저장된 자격증명을 라이브 위치로 **원자적 복원**
3. 활성 프로필 포인터 업데이트

---

## 설치

### npm (권장)

```bash
npm install -g multi-subscription-terminal
```

### Homebrew

> 본 저장소를 GitHub에 올린 뒤 별도 tap 저장소(`homebrew-mat`)에 formula를 추가하면 사용 가능.

```bash
brew tap YOUR-USERNAME/mat
brew install mat
```

자세한 셋업: [PUBLISHING.md](./PUBLISHING.md)

### 소스에서 빌드

```bash
git clone https://github.com/YOUR-USERNAME/multi-subscription-terminal.git
cd multi-subscription-terminal
npm install
npm run build
npm link
```

---

## 사용

```bash
mat
```

TUI가 열리면 **CLI 선택 → 프로필 선택 → 전환**.

### 첫 실행

이미 로그인된 자격증명이 감지되면 `default` 프로필로 가져올지 묻는다.

### 새 계정 추가하기

1. `mat` 실행 → CLI 선택 → `a` (새 프로필) → 이름 입력
2. 새 프로필이 활성화된 상태로 해당 CLI의 로그인 명령 실행 (예: `claude login`)
3. `mat`으로 돌아와 같은 프로필 선택 → `c` (현재 라이브 자격증명 캡처)

### 키바인딩

| 화면 | 키 | 동작 |
| --- | --- | --- |
| 어디서나 | `q` / `Ctrl+C` | 종료 |
| 어디서나 | `Esc` | 뒤로 |
| 홈 / 프로필 | `↑ ↓` | 이동 |
| 홈 / 프로필 | `Enter` | 선택 / 전환 |
| 프로필 | `a` | 새 프로필 추가 |
| 프로필 | `c` | 활성 프로필에 현재 라이브 자격증명 캡처 |
| 프로필 | `r` | 이름 변경 |
| 프로필 | `d` | 삭제 |

---

## 데이터 저장 위치

```
~/.multi-sub-terminal/
├── config.json                   # 활성 프로필 매핑
└── profiles/
    ├── claude/
    │   ├── personal/
    │   │   ├── credentials.json  # keychain 값 백업 (평문 JSON)
    │   │   └── meta.json
    │   └── work/...
    ├── codex/...
    └── gemini/...
```

모든 파일은 `0600` 권한, 디렉토리는 `0700`으로 생성된다.

---

## 보안

### 본질적 trade-off (수용 가능 범위)

- **Keychain ACL 완화**: Claude 자격증명은 본래 macOS Keychain 에 Claude 바이너리만 접근 가능한 ACL 로 보관된다.
  `mat` 은 swap 시 `security add-generic-password -A` 로 **동일 사용자의 모든 앱이 접근 가능**한
  ACL 로 재생성한다 (그렇지 않으면 Claude 가 토큰을 못 읽는 회귀 발생).
  결과: 같은 UID 로 실행되는 임의 프로세스(악성 npm postinstall 포함)가 토큰을 침묵 읽기 가능.
  완화 옵션은 v0.2 (opt-in restrictive 모드 / `-T` 화이트리스트) 로 도입 예정.

- **OAuth 토큰 평문 백업**: `~/.multi-sub-terminal/profiles/` 아래 평문 JSON 으로 저장된다.
  파일 0600 / 디렉토리 0700 권한이지만 디스크 백업/스냅샷에 포함될 수 있다.
  **Time Machine / iCloud / 클라우드 동기화 폴더에서 제외 권장**:

  ```bash
  xattr -w com.apple.metadata:com_apple_backup_excludeItem true ~/.multi-sub-terminal
  ```

- **명령행 인자 노출**: `security add-generic-password -w <value>` 가 평문 토큰을 `argv` 로 받는다
  (`security` CLI 의 한계). `ps -ef` / BSM audit / EDR 로그에 일시적으로 노출된다.
  **audit / EDR 활성 기업 환경에서는 사용 비권장.**

### 기본 보호 장치

- 모든 외부 명령은 `spawn(argv)` 만 사용 (셸 미경유 → injection 차단)
- `security` 는 절대경로 `/usr/bin/security` 만 호출 (PATH shim 공격 방지)
- 모든 파일 쓰기는 `.tmp → rename` (원자적), 실패 시 tmp 자동 정리
- 모든 파일 `0600`, 디렉토리 `0700` 권한
- 프로필 이름 검증: `[a-zA-Z0-9가-힣_.-]{1,40}` + NFC 정규화 + `.` / `..` / `/` / `\` / NUL 명시 차단 (경로 traversal 방지)
- Keychain swap: 백업 → 정확 acct 매칭 delete → add. add 실패 시 자동 롤백 (자격증명 영구 손실 방지)
- 에러 메시지는 JWT 패턴 및 30자+ base64-like 시퀀스를 redact (토큰 누설 방지)
- 의존성: `npm audit` clean

### 사용 비권장 환경

- 공용 / 공유 워크스테이션
- 다중 사용자 호스트
- 관리형 / audit·EDR 활성 기업 기기
- 클라우드 동기화 폴더 안의 home 디렉토리

---

## 새 CLI 추가하기

`src/core/cli-defs.ts`에 정의를 추가:

```ts
{
  id: 'foo',
  name: 'Foo CLI',
  sources: [
    { type: 'file', path: '~/.foo/credentials.json', saveAs: 'credentials.json' }
  ]
}
```

`source.type`은 `'file'` 또는 `'keychain'`을 지원한다.

PR 환영.

---

## 라이센스

MIT — [LICENSE](./LICENSE)
