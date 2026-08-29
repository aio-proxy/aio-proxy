import type { RouterSelectionSource } from '@aio-proxy/core';

// A provider-qualified request ("providerId/slug") acts on the underlying
// public slug for router policy lookups (capability grants, billing). The
// router set selectionSource for exactly these routes, so the strip is exact.
export function publicSlug(
  requestedModelId: string,
  candidate: { readonly provider: { readonly id: string }; readonly selectionSource: RouterSelectionSource },
): string {
  const prefix = `${candidate.provider.id}/`;
  return candidate.selectionSource === 'provider_qualified' && requestedModelId.startsWith(prefix)
    ? requestedModelId.slice(prefix.length)
    : requestedModelId;
}
