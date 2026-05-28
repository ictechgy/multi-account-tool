# PII / Secret Masking Rules

`tests/fixtures/oauth/` 의 fixture 작성 + adapter detail / `mat freshness` 출력의
secret 마스킹 정책. PR-U (PR-T quad-review iter 2 follow-up) 에서 정식 문서화.

---

## 적용 범위

| 위치 | 규칙 |
|---|---|
| **Fixture stored / live (JSON 페이로드)** | 가짜 토큰 패턴 사용 (아래 §Fake Token Patterns) |
| **Fixture email / accountId** | RFC 2606 reserved domain (`@fixture.example`) |
| **Adapter detail string** | `maskIdentifier` 으로 12-hex fingerprint 변환 |
| **`mat freshness --json` 출력** | adapter detail 만 노출, raw payload 미포함 (contract) |
| **`mat freshness` stdout 표** | 동일 — detail 만 |
| **CI 로그 / GHA workflow** | `set -x` / `-v` 금지, secret env mask 사용 (이미 적용) |
| **Git history** | 본 정책 위반 fixture 는 PR-T loader (`assertFixtureShape`) 가 즉시 실패 |

---

## Fake Token Patterns (fixture 전용)

정적 secret scanner (semgrep / gitleaks / trufflehog) 의 기본 룰을 회피하면서
**실제 토큰과 명확히 구분**되는 패턴.

### API Key

```
sk-fake-{provider}-{4hex}
```

예시:
- `sk-fake-anthropic-0001`
- `sk-fake-openai-0042`
- `sk-fake-opencode-00a1`

⚠ 금지 패턴:
- `sk-ant-...` (실제 Anthropic API key prefix)
- `sk-proj-...` (실제 OpenAI project API key)
- 임의의 sk- prefix + 30자+ base64 (gitleaks entropy 룰 매치)

### Refresh / Access Token

```
refresh-fake-{4hex}    # 일반
{provider}fake-{access|refresh}-{4hex}    # provider 특정
```

예시:
- `refresh-fake-0001`
- `gemfake-access-0001` (Gemini — 옛 `ya29.` prefix 회피)
- `gemfake-refresh-0001`

⚠ 금지 패턴:
- `ya29.{50자}` (실제 Google OAuth access token prefix)
- `eyJ...` (JWT — runtime concat 없이 source 에 직접 포함 금지)

### Account ID

```
acc-{4hex}
```

예시: `acc-0001`, `acc-0042`, `acc-00ff`.

### Email

RFC 2606 `.example` reserved TLD:

```
{name}@fixture.example
```

예시: `user-a@fixture.example`, `bob@fixture.example`.

⚠ 금지: `@example.com` (RFC 2606 reserved 지만 흔히 실제 spam 가능성 있는 도메인).
`@fixture.example` 로 통일.

---

## Adapter Detail 마스킹

`maskIdentifier(value: string): string` 이 단일 진입점.

```typescript
import { maskIdentifier } from '../errors.js';

// detail 에 raw email 노출 금지
return {
  kind: 'stale',
  detail: `active 계정 변경: ${maskIdentifier(s.active)} → ${maskIdentifier(l.active)}`
};
```

### 출력 형식

```
<hash:{12hex}>
```

예시: `<hash:a3f9b1c4e5d6>`.

### 빈 문자열

```
<empty>
```

(hash collision 회피 — `''` 가 `'sha256('')` 와 동일한 fingerprint 가 되는 케이스를 명시.)

### Fingerprint 길이

**12 hex (48-bit)** — PR-U 에서 8 → 12 확장.

근거:
- 옛 8 hex (32-bit) birthday bound ~65K identifier → 단일 사용자 (5~10 계정) 안전, fleet (수천 사용자 aggregate) 충돌 위험
- 12 hex (48-bit) birthday bound ~16M → fleet/audit 시나리오에서도 충돌 실용 무시 가능
- UI 표시 폭 trade-off: 4 chars 증가 (가독성 영향 미미)

---

## 정적 분석 우회 권장

다음 도구는 fixture / source code 의 secret 패턴을 매치할 수 있다:
- semgrep (`semgrep mcp -k post-tool-cli-scan` 등)
- gitleaks (entropy + prefix 룰)
- trufflehog (정규식 + entropy)

**우회 전략**:
1. **Fake prefix 만 사용** (`sk-fake-`, `gemfake-`, `refresh-fake-`)
2. **JWT 패턴 (`eyJ`) 은 runtime concat** (`'ey' + 'J' + 'rest'`) 으로 source 매치 회피
3. **Email 은 `@fixture.example`** RFC 2606
4. **Number/UUID 는 짧고 명확한 fake** (`acc-0001`, `0xfake-0001`)

---

## 본 정책 검증

`tests/contract/adapters.test.ts` 의 `assertFixtureShape` 가 schema 검증.
fixture 의 secret 패턴 자체는 source-level scanner 가 우회 검증 — semgrep run 에서
ERROR 없으면 OK.

새 마스킹 규칙 변경 시:
1. 본 문서 + `src/core/errors.ts` 의 `MASK_FINGERPRINT_LENGTH` 동시 갱신.
2. `tests/core/errors-mask.test.ts` + `freshness-adapters/*.test.ts` 의 hash regex 길이도 동시 갱신.
3. `tests/fixtures/oauth/README.md` 의 fake token guidance 갱신.
