import { type ModelsDevModelMetadata, modelRoutes } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';
import { filter, flatMap, map, pipe, uniqBy } from 'es-toolkit/fp';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly metadata: ModelsDevModelMetadata | undefined;
};

type ModelRouteCandidate = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
};

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
      const aliasMetadata = catalog?.metadata(route.slug);
      const upstreamMetadata =
        route.slug === route.modelId || aliasMetadata?.displayName !== undefined
          ? undefined
          : catalog?.metadata(route.modelId);
      return {
        slug: route.slug,
        modelId: route.modelId,
        provider: route.provider,
        metadata: aliasMetadata ?? upstreamMetadata,
      };
    })(routes);
  } finally {
    lease.release();
  }
}

export function resolveDisplayName(
  provider: RuntimeProviderInstance,
  modelId: string,
  slug: string,
  metadata: ModelsDevModelMetadata | undefined,
): string {
  if (provider.kind === ProviderKind.OAuth) {
    return provider.modelMetadata?.[modelId]?.displayName ?? metadata?.displayName ?? slug;
  }
  return metadata?.displayName ?? slug;
}
