# OAuth Fixture Library

각 freshness adapter (codex / gemini / opencode / claude / goose) 의 분류 행동을
**고정된 입력 → 기대 출력** 으로 contract test 하기 위한 fixture 모음.

## 파일 형식

각 fixture 는 JSON:

```json
{
  "name": "human-readable case name",
  "cli": "codex",
  "saveAs": "auth.json",
  "stored": "<JSON or YAML payload as string>",
  "live": "<JSON or YAML payload as string>",
  "expected": {
    "kind": "fresh|rotated|stale|inflight",
    "subtype": "value-only|meta-only|both",
    "confidence": "high|medium|low"
  }
}
```

- `stored` / `live` 는 **문자열** (adapter.compare 가 raw 받기 때문). YAML 도 단순 문자열.
- `expected.subtype` / `expected.confidence` 는 옵션 — 명시한 필드만 검증.
- `expected.kind` 는 필수.

## 마스킹 규칙

fixture 의 secret 값은 **가짜** 여야 한다 — 실제 토큰을 사용하면 git history 누설.

규칙 (PR-U 후속에서 MASKING_RULES.md 로 분리 예정):
- API key: `sk-fake-{provider}-{4hex}` 패턴 — 예: `sk-fake-anthropic-0001`
- JWT: runtime concat 없이 그대로 사용 시 base64 prefix `eyJ` 만 포함 + payload 는 `fake.payload.signature` 같은 placeholder
- account_id / email: 도메인 `@fixture.example` 사용 (RFC 2606 reserved)
- refresh_token: `refresh-fake-{4hex}` 패턴

본 정책은 PR-T 의 최초 fixture 셋에서 사용하고 PR-U 에서 정식 문서화.

## 신규 fixture 추가

1. 적절한 adapter 디렉토리 (`<cli>/`) 에 `<scenario>.json` 추가
2. `npm run test:contract` 으로 통과 확인
3. PR 본문에 fixture 추가 의도 명시

## 회귀 가드 목적

- adapter 의 분류 로직 변경이 의도된 결과인지 fixture diff 로 검증
- 새 adapter 추가 시 동일 fixture 패턴 따라 빠르게 contract 정의 가능
- CI 가 fixture 와 adapter 의 일관성을 자동 검증
