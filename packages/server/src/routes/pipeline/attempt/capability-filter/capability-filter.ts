import type { InboundCapability, RouterSelectionSource } from '@aio-proxy/core';
import type { RouterModelPolicy } from '@aio-proxy/types';

import {
  metadataHasImageOutput,
  supportsEmbedding,
  supportsImage,
  supportsLanguage,
} from '../../../../provider-runtime';
import type { RuntimeProviderInstance } from '../../../../runtime';
import { publicSlug } from '../../public-slug';

export function filterCandidatesByCapability<
  T extends { provider: RuntimeProviderInstance; modelId: string; selectionSource: RouterSelectionSource },
>(
  candidates: readonly T[],
  capability: InboundCapability,
  routing: {
    readonly requestedModelId: string;
    readonly routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined;
  },
): T[] {
  return candidates.filter((candidate) => {
    if (capability === 'image') {
      return candidateSupportsImage(candidate, routing.requestedModelId, routing.routerModels);
    }
    if (capability === 'embedding') return supportsEmbedding(candidate.provider.capabilityIndex, candidate.modelId);
    return supportsLanguage(candidate.provider.capabilityIndex, candidate.modelId);
  });
}

// Effective image support: the upstream-id index OR the requested slug's
// router-policy grant. The SAME predicate gates the capability filter and
// dispatchImageCandidate - a candidate that passes the filter must never be
// re-rejected downstream by an index-only check.
export function candidateSupportsImage(
  candidate: {
    readonly provider: Pick<RuntimeProviderInstance, 'id' | 'capabilityIndex'>;
    readonly modelId: string;
    readonly selectionSource: RouterSelectionSource;
  },
  requestedModelId: string,
  routerModels: Readonly<Record<string, RouterModelPolicy>> | undefined,
): boolean {
  return (
    supportsImage(candidate.provider.capabilityIndex, candidate.modelId) ||
    metadataHasImageOutput(routerModels?.[publicSlug(requestedModelId, candidate)]?.metadata)
  );
}
