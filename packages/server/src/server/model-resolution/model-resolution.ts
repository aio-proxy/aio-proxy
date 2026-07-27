import { getModels, type ModelsDevModel, modelRoutes } from '@aio-proxy/core';
import { filter, flatMap, map, pipe, uniqBy } from 'es-toolkit/fp';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly metadata: ModelsDevModel | undefined;
  readonly displayName: string;
};

type ModelRouteCandidate = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
};

// An alias is a fully self-contained public view: metadata is read only from the
// alias slug's own catalog entry, never from the upstream modelId. The upstream
// model's catalog name/capabilities/token limits must not leak to clients.
function resolveDisplayName(
  provider: RuntimeProviderInstance,
  modelId: string,
  slug: string,
  metadata: ModelsDevModel | undefined,
): string {
  const catalogName = metadata !== undefined && metadata.name !== metadata.id ? metadata.name : undefined;
  return provider.modelMetadata?.[modelId]?.displayName ?? catalogName ?? slug;
}

export async function resolveEnabledModels(state: ServerState): Promise<readonly ResolvedModel[]> {
  const lease = state.acquireProviderSnapshot();
  try {
    const routes = pipe(
      lease.snapshot.providers,
      filter((provider) => provider.enabled),
      flatMap((provider) =>
        modelRoutes(provider).map((route) => ({ slug: route.alias, modelId: route.modelId, provider })),
      ),
      uniqBy(({ slug }) => slug),
    );

    // metadata is read from the alias slug's own catalog entry, never the
    // upstream modelId, so a single batched lookup keyed by slug suffices.
    const metadataBySlug =
      routes.length === 0 ? {} : await getModels(routes.map((route) => route.slug)).catch(() => ({}));

    return map((route: ModelRouteCandidate): ResolvedModel => {
      const metadata = metadataBySlug[route.slug];
      return {
        slug: route.slug,
        modelId: route.modelId,
        provider: route.provider,
        metadata,
        displayName: resolveDisplayName(route.provider, route.modelId, route.slug, metadata),
      };
    })(routes);
  } finally {
    lease.release();
  }
}
