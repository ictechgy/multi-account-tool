# OAuth Fixture Library

각 freshness adapter (codex / gemini / opencode / claude / goose) 의 분류 행동을
**고정된 입력 → 기대 출력** 으로 contract test 하기 위한 fixture 모음.

## 파일 형식 (v1 — single-source)

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

필수 필드 (PR-T Codex iter 1 MED fix):
- `name`, `cli`, `saveAs`, `stored`, `live`, `expected.kind` **필수**.
- `kind === 'rotated'` 이면 `expected.subtype` **필수** (분류 강도 변경 회귀 가드).
- `kind === 'rotated'` 또는 `'stale'` 이면 `expected.confidence` **필수** (user-visible 안전성 판정 — high/medium 이 자동 swap 허용 vs low 가 dialog 차단).
- `kind === 'fresh'` 이면 `confidence` 는 옵션 (기본 high 가정).

검증 invariant 는 `tests/contract/adapters.test.ts` 의 `assertFixtureShape` 가 강제 — 잘못된 fixture 는 loader 단계에서 실패.

### confidence 선택 가이드

- `high`: adapter 가 identity 필드 (account_id / subscriptionType / keychain account) 로 명시 분류.
- `medium`: identity 필드 부재거나 byte-diff 매트릭스 기반 (Goose flat YAML 매트릭스 등).
- `low`: parse 실패 / 매트릭스 추출 0/0 / wrapper 손상 / fallback byte-diff.

### v2 (계획 — 후속 PR 도입 예정) — multi-source aggregate fixture

⚠ **현재 미구현**: loader (`tests/contract/adapters.test.ts`) 는 v1 single-source 만 지원. 본 섹션은 향후 schema 계획 — fixture 작성 시 v1 만 사용.

`inflight` 케이스 (multi-source CLI 의 한 source 만 갱신된 race) 는 현재 v1 schema 의 단일 (saveAs, stored, live) 로 표현 불가. PR-S 는 cross-source aggregation 로직만 구현 (real fs 통합 tests/core/freshness.test.ts 에서 검증). fixture-based contract test 는 향후 PR 에서 다음 schema 로 추가 예정:

```json
{
  "cli": "gemini",
  "sources": [
    { "saveAs": "oauth_creds.json", "stored": "...", "live": "..." },
    { "saveAs": "google_accounts.json", "stored": "...", "live": "..." }
  ],
  "expected": { "kind": "inflight", "confidence": "medium" }
}
```

도입 시 loader 가 `sources` 유무로 v1/v2 자동 분기. 본 PR (PR-S) 머지 후 별도 follow-up.

## 마스킹 규칙

fixture 의 secret 값은 **가짜** 여야 한다 — 실제 토큰을 사용하면 git history 누설.

정식 규칙은 **`MASKING_RULES.md`** (PR-U) 참고 — fake token patterns + 금지 패턴 +
정적 분석 우회 가이드 + 변경 시 동기화 매트릭스 포함.

요약:
- API key: `sk-fake-{provider}-{4hex}` — 예: `sk-fake-anthropic-0001`
- JWT: source 직접 포함 금지 (`eyJ` 정적 매치 회피). runtime concat 권장.
- account_id / email: 도메인 `@fixture.example` (RFC 2606 reserved)
- refresh / access token: `refresh-fake-{4hex}` 또는 `{provider}fake-{access|refresh}-{4hex}`

## 신규 fixture 추가

1. 적절한 adapter 디렉토리 (`<cli>/`) 에 `<scenario>.json` 추가
2. `npm run test:contract` 으로 통과 확인
3. PR 본문에 fixture 추가 의도 명시

## 회귀 가드 목적

- adapter 의 분류 로직 변경이 의도된 결과인지 fixture diff 로 검증
- 새 adapter 추가 시 동일 fixture 패턴 따라 빠르게 contract 정의 가능
- CI 가 fixture 와 adapter 의 일관성을 자동 검증
