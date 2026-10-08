/**
 * 영어 메시지 — `freshnessDetails` 영역 (freshness 비교 결과의 detail).
 *
 * 영어 문구는 `mat freshness --json` 의 `detail` 로 **언어 설정과 무관하게** 그대로 나가는 안정된 값이다.
 * 바꾸면 JSON 을 읽는 스크립트가 영향받으므로 CHANGELOG 에 적는다. 키 구조는 ko/freshnessDetails.ts 와 같아야 한다.
 */
export const freshnessDetails = {
  // 공용
  unsupportedSource: (adapter: string, saveAs: string) => `${adapter} adapter: unsupported source ${saveAs}`,
  keychainAccountChanged: (from: string, to: string) => `Keychain account changed: ${from} → ${to}`,

  // freshness.ts (공통 분기 · fallback)
  bothMissing: 'missing on both sides — not affected by swap',
  storedMissing: 'saved profile copy missing — capture live recommended',
  liveMissing: 'live missing — CLI likely logged out',
  fallbackNoRotationFields: 'fallback: no allowlisted rotation fields — consider adding an adapter',
  fallbackCacheOnly: 'rotation candidate fields unchanged — only cache fields changed (normal use)',
  fallbackByteDiff: 'fallback byte-diff: identity cannot be confirmed — CLI has no adapter',
  nonJson: 'non-JSON content — byte comparison only',
  backendMeta: (reason: string, target: string) => `${reason}: ${target}`,
  crossSourceRace: (previousKind: string) => `cross-source race (previous classification: ${previousKind}) — retry recommended`,
  adapterException: (message: string) => `adapter exception: ${message}`,

  // Claude
  claudeParseFailed: 'Claude credentials JSON parse failed — possibly corrupted',
  claudeWrapperAsymmetric: 'KeychainStored wrapper asymmetric — credentials likely corrupted',
  claudeAccountAsymmetric: 'KeychainStored.account asymmetric — credentials likely corrupted',
  claudeOauthMissing: 'claudeAiOauth field missing — API key mode or corrupted',
  claudeSubscriptionChanged: 'subscriptionType changed — likely a different plan/account',
  claudeSubscriptionAsymmetric: 'subscriptionType asymmetric — identity cannot be confirmed',
  claudeTokensMissing: 'OAuth token missing on both sides — credentials likely corrupted',
  claudeTokenRotation: 'same subscriptionType, OAuth token rotation',
  claudeExpiresOnly: 'same token, only expiresAt changed',
  claudeOtherFields: 'other OAuth fields changed (scopes, etc.)',

  // Codex
  codexParseFailed: 'Codex auth.json JSON parse failed — possibly corrupted',
  codexAccountChanged: 'tokens.account_id changed — different account',
  codexTokenRotation: 'same identity, token rotation',
  codexCacheOnly: 'same token, only cache fields changed',
  codexApiKeySame: 'API key mode, same key',
  codexApiKeyChanged: 'OPENAI_API_KEY changed — different key',
  codexIdentityMissing: 'identity fields missing (tokens.account_id / OPENAI_API_KEY)',

  // OpenCode
  opencodeAccountChanged: (from: string, to: string) => `accountId changed: ${from} → ${to}`,
  opencodeTokenRotation: 'OAuth token rotation',
  opencodeCacheOnly: 'only cache fields such as expires changed',
  opencodeApiKeySame: 'same API key',
  opencodeApiKeyChanged: 'API key changed',
  opencodeTypeMismatch: (stored: string, live: string) => `provider type mismatch: stored=${stored} live=${live}`,
  opencodeParseFailed: 'OpenCode auth.json JSON parse failed',
  opencodeProviderOneSide: (provider: string) => `provider ${provider} exists on only one side`,

  // Gemini
  geminiOauthParseFailed: 'oauth_creds.json JSON parse failed',
  geminiTokenChanged: 'OAuth token changed — review together with google_accounts.active',
  geminiMetaOnly: 'same token, only expiry_date/scope etc. changed',
  geminiAccountsParseFailed: 'google_accounts.json JSON parse failed',
  geminiActiveChanged: (from: string, to: string) => `active account changed: ${from} → ${to}`,
  geminiOldOnly: 'same active account, only the old list changed',
  geminiActiveMissing: 'active field missing — identity cannot be confirmed',

  // Goose
  gooseKeySetChanged: (label: string, from: string, to: string) => `${label} key set changed: ${from} → ${to}`,
  gooseIdentityKeyChanged: (label: string, key: string) =>
    `${label} identity key '${key}' value changed — likely a different provider/account`,
  gooseValuesChanged: (label: string) => `${label} same key set, values changed (likely rotation)`,
  gooseOtherFields: (label: string) => `${label} same keys, only other fields changed`,
  gooseYamlNoKeys: (label: string, parseFailed: boolean) =>
    `Goose YAML: no ${label} keys detected${parseFailed ? ' + YAML parse failed' : ''} — byte comparison only`,
  /** 다른 detail 뒤에 붙는 접미사. */
  gooseYamlParseHint: ' (YAML parse failed — corrupted YAML or spec violation)',
  gooseWrapperParseFailed: 'Goose keyring KeychainStored wrapper parse failed',
  gooseInnerMissing: 'Goose keyring inner value missing or not a string',
  gooseAccountAsymmetric: 'KeychainStored.account asymmetric — keyring likely corrupted',
  gooseAccountBothNonString: 'KeychainStored.account is not a string on either side — keyring likely corrupted',
  gooseProviderCacheChanged: 'Goose provider cache changed (opaque v1.43 admission)',

  // Crush
  crushByteDiff: 'Crush OAuth: identity unknown; conservative byte-diff (no confirmed rotation)'
};
