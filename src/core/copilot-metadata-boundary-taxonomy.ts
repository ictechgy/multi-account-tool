/**
 * Shared Copilot metadata boundary taxonomy.
 *
 * These normalized key sets are intentionally centralized so metadata-only gates
 * reject credential evidence, product-support claims, and completed-proof claims
 * without duplicating string taxonomies in each gate. Claim predicates stay
 * gate-specific because each gate has a different schema contract.
 */

const COPILOT_FORBIDDEN_EVIDENCE_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
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

const COPILOT_PROOF_METADATA_ADMISSION_CLAIM_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'productsupport',
  'prooflevel',
  'platformproofcomplete',
  'platformproofclaimedcomplete',
  'supportstatus',
  'builtin',
  'sourcetype',
  'runtimewiring',
  'productsupportclaimed',
  'copilotbuiltin',
  'productwiring',
  'platformsupport'
]);

const COPILOT_EXECUTABLE_PROBE_PRODUCT_SUPPORT_CLAIM_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'productsupport',
  'supportstatus',
  'builtin',
  'copilotbuiltin',
  'runtimewiring',
  'productwiring',
  'platformsupport'
]);

const COPILOT_EXECUTABLE_PROBE_PLATFORM_PROOF_CLAIM_NORMALIZED_KEYS: ReadonlySet<string> = new Set([
  'prooflevel',
  'platformproof',
  'platformproofcomplete',
  'proofcomplete'
]);

export function normalizeCopilotMetadataKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

export function isCopilotForbiddenEvidenceKey(
  key: string,
  safeMetadataNormalizedKeys: ReadonlySet<string>
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

export function isCopilotProofMetadataAdmissionClaimKey(key: string): boolean {
  return COPILOT_PROOF_METADATA_ADMISSION_CLAIM_NORMALIZED_KEYS.has(normalizeCopilotMetadataKey(key));
}

export function isCopilotExecutableProbeProductSupportClaimKey(key: string): boolean {
  return COPILOT_EXECUTABLE_PROBE_PRODUCT_SUPPORT_CLAIM_NORMALIZED_KEYS.has(normalizeCopilotMetadataKey(key));
}

export function isCopilotExecutableProbePlatformProofClaimKey(key: string): boolean {
  return COPILOT_EXECUTABLE_PROBE_PLATFORM_PROOF_CLAIM_NORMALIZED_KEYS.has(normalizeCopilotMetadataKey(key));
}
