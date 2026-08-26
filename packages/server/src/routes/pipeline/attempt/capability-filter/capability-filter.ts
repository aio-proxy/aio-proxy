import type { InboundCapability } from '@aio-proxy/core';

import { supportsEmbedding, supportsImage, supportsLanguage } from '../../../../provider-runtime';
import type { RuntimeProviderInstance } from '../../../../runtime';

export function filterCandidatesByCapability<T extends { provider: RuntimeProviderInstance; modelId: string }>(
  candidates: readonly T[],
  capability: InboundCapability,
): T[] {
  return candidates.filter((candidate) => {
    if (capability === 'image') return supportsImage(candidate.provider.capabilityIndex, candidate.modelId);
    if (capability === 'embedding') return supportsEmbedding(candidate.provider.capabilityIndex, candidate.modelId);
    return supportsLanguage(candidate.provider.capabilityIndex, candidate.modelId);
  });
}
