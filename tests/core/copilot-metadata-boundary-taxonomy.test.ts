import { describe, expect, it } from 'vitest';

import {
  isCopilotForbiddenEvidenceKey,
  isCopilotPlatformProofClaimKey,
  isCopilotProductOrProofClaimKey,
  isCopilotProductSupportClaimKey,
  normalizeCopilotMetadataKey
} from '../../src/core/copilot-metadata-boundary-taxonomy.js';

describe('Copilot metadata boundary taxonomy', () => {
  it('normalizes boundary keys consistently for all Copilot metadata gates', () => {
    expect(normalizeCopilotMetadataKey('product-Support_Claimed')).toBe('productsupportclaimed');
    expect(normalizeCopilotMetadataKey('raw credential store output')).toBe('rawcredentialstoreoutput');
  });

  it('classifies forbidden evidence keys with caller-owned schema exemptions', () => {
    expect(isCopilotForbiddenEvidenceKey('rawOutput')).toBe(true);
    expect(isCopilotForbiddenEvidenceKey('tokenHash')).toBe(true);
    expect(isCopilotForbiddenEvidenceKey('rawLocalOutputPolicy')).toBe(true);
    expect(isCopilotForbiddenEvidenceKey('rawLocalOutputPolicy', new Set(['rawlocaloutputpolicy']))).toBe(false);
  });

  it('separates product-support and platform-proof claim taxonomy', () => {
    expect(isCopilotProductSupportClaimKey('productSupportClaimed')).toBe(true);
    expect(isCopilotProductSupportClaimKey('runtimeWiring')).toBe(true);
    expect(isCopilotPlatformProofClaimKey('platformProofClaimedComplete')).toBe(true);
    expect(isCopilotPlatformProofClaimKey('proofLevel')).toBe(true);
    expect(isCopilotProductOrProofClaimKey('proofLevel')).toBe(true);
  });
});
