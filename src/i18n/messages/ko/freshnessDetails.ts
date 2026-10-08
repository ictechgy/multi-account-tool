import type { Messages } from '../en.js';

/** 한국어 메시지 — `freshnessDetails` 영역. 화면(표·TUI)에만 쓰이고 `--json` 에는 영어가 나간다. */
export const freshnessDetails: Messages['freshnessDetails'] = {
  unsupportedSource: (adapter: string, saveAs: string) => `${adapter} adapter: 미지원 source ${saveAs}`,
  keychainAccountChanged: (from: string, to: string) => `Keychain account 변경: ${from} → ${to}`,

  bothMissing: '양쪽 부재 — swap 무관',
  storedMissing: '프로필 저장본 부재 — 라이브 캡처 권장',
  liveMissing: '라이브 부재 — CLI 로그아웃 추정',
  fallbackNoRotationFields: 'fallback: 화이트리스트 회전 필드 부재 — adapter 추가 권장',
  fallbackCacheOnly: '회전 후보 필드 동일 — 캐시 필드만 변경 (정상 사용)',
  fallbackByteDiff: 'fallback byte-diff: identity 확정 불가 — adapter 미등록 CLI',
  nonJson: 'non-JSON content — byte 비교만',
  backendMeta: (reason: string, target: string) => `${reason}: ${target}`,
  crossSourceRace: (previousKind: string) => `cross-source race (옛 분류: ${previousKind}) — 재시도 권장`,
  adapterException: (message: string) => `adapter 예외: ${message}`,

  claudeParseFailed: 'Claude credentials JSON parse 실패 — 손상 가능성',
  claudeWrapperAsymmetric: 'KeychainStored wrapper 비대칭 — credentials 손상 추정',
  claudeAccountAsymmetric: 'KeychainStored.account 비대칭 — credentials 손상 추정',
  claudeOauthMissing: 'claudeAiOauth 필드 부재 — API key 모드 또는 손상',
  claudeSubscriptionChanged: 'subscriptionType 변경 — 다른 plan/계정 추정',
  claudeSubscriptionAsymmetric: 'subscriptionType 비대칭 — identity 확정 불가',
  claudeTokensMissing: 'OAuth token 양쪽 모두 부재 — credentials 손상 추정',
  claudeTokenRotation: 'subscriptionType 동일, OAuth token rotation',
  claudeExpiresOnly: 'token 동일, expiresAt 만 변경',
  claudeOtherFields: '기타 OAuth 필드 변경 (scopes 등)',

  codexParseFailed: 'Codex auth.json JSON parse 실패 — 손상 가능성',
  codexAccountChanged: 'tokens.account_id 변경 — 다른 계정',
  codexTokenRotation: 'identity 동일, token rotation',
  codexCacheOnly: 'token 동일, 캐시 필드만 변경',
  codexApiKeySame: 'API key 모드, 동일 키',
  codexApiKeyChanged: 'OPENAI_API_KEY 변경 — 다른 키',
  codexIdentityMissing: 'identity 필드 부재 (tokens.account_id / OPENAI_API_KEY)',

  opencodeAccountChanged: (from: string, to: string) => `accountId 변경: ${from} → ${to}`,
  opencodeTokenRotation: 'OAuth 토큰 rotation',
  opencodeCacheOnly: 'expires 등 캐시 필드만 변경',
  opencodeApiKeySame: 'API key 동일',
  opencodeApiKeyChanged: 'API key 변경',
  opencodeTypeMismatch: (stored: string, live: string) => `provider type 불일치: stored=${stored} live=${live}`,
  opencodeParseFailed: 'OpenCode auth.json JSON parse 실패',
  opencodeProviderOneSide: (provider: string) => `provider ${provider} 가 한쪽에만 존재`,

  geminiOauthParseFailed: 'oauth_creds.json JSON parse 실패',
  geminiTokenChanged: 'OAuth 토큰 변경 — google_accounts.active 와 함께 검토 필요',
  geminiMetaOnly: '토큰 동일, expiry_date/scope 등만 변경',
  geminiAccountsParseFailed: 'google_accounts.json JSON parse 실패',
  geminiActiveChanged: (from: string, to: string) => `active 계정 변경: ${from} → ${to}`,
  geminiOldOnly: 'active 동일, old 목록만 변경',
  geminiActiveMissing: 'active 필드 부재 — identity 확정 불가',

  gooseKeySetChanged: (label: string, from: string, to: string) => `${label} 키 set 변경: ${from} → ${to}`,
  gooseIdentityKeyChanged: (label: string, key: string) =>
    `${label} identity 키 '${key}' 값 변경 — 다른 provider/계정 swap 추정`,
  gooseValuesChanged: (label: string) => `${label} 키 set 동일, 값 변경 (rotation 추정)`,
  gooseOtherFields: (label: string) => `${label} 키 동일, 외 필드만 변경`,
  gooseYamlNoKeys: (label: string, parseFailed: boolean) =>
    `Goose YAML: ${label} 키 미감지${parseFailed ? ' + YAML parse 실패' : ''} — byte 비교만`,
  gooseYamlParseHint: ' (YAML parse 실패 — 손상된 YAML 또는 spec 위반)',
  gooseWrapperParseFailed: 'Goose keyring KeychainStored wrapper parse 실패',
  gooseInnerMissing: 'Goose keyring inner value 부재 또는 비-문자열',
  gooseAccountAsymmetric: 'KeychainStored.account 비대칭 — keyring 손상 추정',
  gooseAccountBothNonString: 'KeychainStored.account 양쪽 모두 비-string — keyring 손상 추정',
  gooseProviderCacheChanged: 'Goose provider cache changed (opaque v1.43 admission)',

  crushByteDiff: 'Crush OAuth: identity unknown; conservative byte-diff (no confirmed rotation)'
};
