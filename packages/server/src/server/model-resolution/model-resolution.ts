import { type ModelsDevModelMetadata, modelRoutes } from '@aio-proxy/core';
import { filter, flatMap, map, pipe, uniqBy } from 'es-toolkit/fp';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly metadata: ModelsDevModelMetadata | undefined;
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
  metadata: ModelsDevModelMetadata | undefined,
): string {
  return provider.modelMetadata?.[modelId]?.displayName ?? metadata?.displayName ?? slug;
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

    const catalog = routes.length === 0 ? undefined : await state.modelsDevCatalog().catch(() => undefined);

    return map((route: ModelRouteCandidate): ResolvedModel => {
      const metadata = catalog?.metadata(route.slug);
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
