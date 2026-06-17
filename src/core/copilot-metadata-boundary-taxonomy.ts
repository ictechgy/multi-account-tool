/**
 * Shared Copilot metadata boundary taxonomy.
 *
 * These normalized key sets are intentionally centralized so metadata-only gates
 * reject credential evidence, product-support claims, and completed-proof claims
 * consistently as the proof schemas evolve.
 */

const EMPTY_SAFE_METADATA_NORMALIZED_KEYS: ReadonlySet<string> = new Set();

export const COPILOT_FORBIDDEN_EVIDENCE_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'securityoutput',
  'secrettooloutput',
  'rawoutput',
  'rawcredentialstoreoutput',
  'rawtargetname',
  'credentialblob',
  'target',
  'targetname',
  'token',
  'accesstoken',
  'refreshtoken',
  'oauthtoken',
  'githubtoken',
  'tokenhash',
  'secret',
  'password',
  'hash',
  'fingerprint',
  'digest',
  'sha256',
  'sha256digest',
  'login',
  'displaylogin',
  'account',
  'accountusernameguard',
  'organization',
  'org',
  'accountid',
  'stableaccountid',
  'userid',
  'username',
  'accountlabel',
  'label'
]);

export const COPILOT_PRODUCT_SUPPORT_CLAIM_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'productsupport',
  'supportstatus',
  'builtin',
  'sourcetype',
  'runtimewiring',
  'productsupportclaimed',
  'copilotbuiltin',
  'productwiring',
  'platformsupport'
]);

export const COPILOT_PLATFORM_PROOF_CLAIM_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'prooflevel',
  'platformproof',
  'platformproofcomplete',
  'platformproofclaimedcomplete',
  'proofcomplete'
]);

export function normalizeCopilotMetadataKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function isCopilotForbiddenEvidenceKey(
  key: string,
  safeMetadataNormalizedKeys: ReadonlySet<string> = EMPTY_SAFE_METADATA_NORMALIZED_KEYS
): boolean {
  const normalized = normalizeCopilotMetadataKey(key);
  if (safeMetadataNormalizedKeys.has(normalized)) return false;
  return (
    COPILOT_FORBIDDEN_EVIDENCE_NORMALIZED_KEYS.has(normalized) ||
    normalized.includes('token') ||
    normalized.includes('secret') ||
    normalized.includes('password') ||
    normalized.includes('hash') ||
    normalized.includes('fingerprint') ||
    normalized.includes('digest') ||
    normalized.includes('sha256') ||
    (normalized.includes('raw') && normalized.includes('output')) ||
    (normalized.includes('credential') && normalized.includes('blob'))
  );
}

export function isCopilotProductSupportClaimKey(key: string): boolean {
  return COPILOT_PRODUCT_SUPPORT_CLAIM_NORMALIZED_KEYS.has(normalizeCopilotMetadataKey(key));
}

export function isCopilotPlatformProofClaimKey(key: string): boolean {
  return COPILOT_PLATFORM_PROOF_CLAIM_NORMALIZED_KEYS.has(normalizeCopilotMetadataKey(key));
}

export function isCopilotProductOrProofClaimKey(key: string): boolean {
  return isCopilotProductSupportClaimKey(key) || isCopilotPlatformProofClaimKey(key);
}
