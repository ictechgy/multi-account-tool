import { describe, expect, it } from 'vitest';

import {
  isCopilotExecutableProbePlatformProofClaimKey,
  isCopilotExecutableProbeProductSupportClaimKey,
  isCopilotForbiddenEvidenceKey,
  isCopilotProofMetadataAdmissionClaimKey,
  normalizeCopilotMetadataKey
} from '../../src/core/copilot-metadata-boundary-taxonomy.js';

describe('Copilot metadata boundary taxonomy', () => {
  it('normalizes boundary keys consistently for all Copilot metadata gates', () => {
    expect(normalizeCopilotMetadataKey('product-Support_Claimed')).toBe('productsupportclaimed');
    expect(normalizeCopilotMetadataKey('raw credential store output')).toBe('rawcredentialstoreoutput');
  });

  it('classifies forbidden evidence keys with caller-owned schema exemptions', () => {
    expect(isCopilotForbiddenEvidenceKey('rawOutput', new Set())).toBe(true);
    expect(isCopilotForbiddenEvidenceKey('tokenHash', new Set())).toBe(true);
    expect(isCopilotForbiddenEvidenceKey('rawLocalOutputPolicy', new Set())).toBe(true);
    expect(isCopilotForbiddenEvidenceKey('rawLocalOutputPolicy', new Set(['rawlocaloutputpolicy']))).toBe(false);
  });

  it('keeps gate-specific claim taxonomy explicit in the shared module', () => {
    expect(isCopilotProofMetadataAdmissionClaimKey('productSupportClaimed')).toBe(true);
    expect(isCopilotProofMetadataAdmissionClaimKey('sourceType')).toBe(true);
    expect(isCopilotProofMetadataAdmissionClaimKey('platformProofClaimedComplete')).toBe(true);
    expect(isCopilotProofMetadataAdmissionClaimKey('platformProof')).toBe(false);
    expect(isCopilotProofMetadataAdmissionClaimKey('proofComplete')).toBe(false);

    expect(isCopilotExecutableProbeProductSupportClaimKey('runtimeWiring')).toBe(true);
    expect(isCopilotExecutableProbeProductSupportClaimKey('sourceType')).toBe(false);
    expect(isCopilotExecutableProbeProductSupportClaimKey('productSupportClaimed')).toBe(false);
    expect(isCopilotExecutableProbePlatformProofClaimKey('platformProof')).toBe(true);
    expect(isCopilotExecutableProbePlatformProofClaimKey('platformProofClaimedComplete')).toBe(false);
  });
});
