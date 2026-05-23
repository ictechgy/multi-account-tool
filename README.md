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

- Claude 자격증명은 원래 macOS Keychain에 보관된다. 본 도구는 Keychain 항목을 읽고/쓸 때 시스템의 `security` CLI를 사용한다.
- Keychain 항목을 새로 쓸 때 `-A` 플래그(모든 앱 허용)를 사용한다. 이는 같은 사용자로 실행되는 다른 앱이 해당 항목에 접근할 수 있음을 의미한다. (Claude Code의 기본 ACL은 Claude 바이너리에 한정.)
- 자격증명 백업 파일은 `~/.multi-sub-terminal/profiles/` 아래 평문으로 저장된다 (OAuth 토큰).
- **공용/공유 기기에서는 사용을 권장하지 않는다.**

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
