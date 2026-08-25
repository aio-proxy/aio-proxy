import type { InboundCapability } from '@aio-proxy/core';

import { supportsImage, supportsLanguage } from '../../../../provider-runtime';
import type { RuntimeProviderInstance } from '../../../../runtime';

export function filterCandidatesByCapability<T extends { provider: RuntimeProviderInstance; modelId: string }>(
  candidates: readonly T[],
  capability: InboundCapability,
): T[] {
  return candidates.filter((candidate) =>
    capability === 'image'
      ? supportsImage(candidate.provider.capabilityIndex, candidate.modelId)
      : supportsLanguage(candidate.provider.capabilityIndex, candidate.modelId),
  );
}
