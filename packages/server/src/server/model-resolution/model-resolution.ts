import { getModels, type ModelsDevModel, modelRoutes } from '@aio-proxy/core';
import { ModelContextAggregation } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly metadata: ModelsDevModel | undefined;
  readonly displayName: string;
  // Client-facing context window after config override + cross-provider
  // aggregation; undefined => downstream applies its own default.
  readonly contextWindow: number | undefined;
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
  return provider.metadata?.[modelId]?.name ?? catalogName ?? slug;
}

// Effective context window for one candidate: config override wins over catalog.
// Config limit.context preferred, then limit.input; models.dev exposes input or context.
function candidateContextWindow(
  provider: RuntimeProviderInstance,
  modelId: string,
  metadata: ModelsDevModel | undefined,
): number | undefined {
  const limit = provider.metadata?.[modelId]?.limit;
  return limit?.context ?? limit?.input ?? metadata?.limit.input ?? metadata?.limit.context;
}

// The same public slug from multiple providers can carry different windows.
// min = usable on every channel (conservative); max = largest any offers.
// Absent values do not participate.
function aggregateContextWindow(
  values: readonly (number | undefined)[],
  aggregation: (typeof ModelContextAggregation)[keyof typeof ModelContextAggregation],
): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  if (present.length === 0) return undefined;
  return aggregation === ModelContextAggregation.Max ? Math.max(...present) : Math.min(...present);
}

export async function resolveEnabledModels(state: ServerState): Promise<readonly ResolvedModel[]> {
  const lease = state.acquireProviderSnapshot();
  try {
    const aggregation = lease.snapshot.config?.router.modelContextAggregation ?? ModelContextAggregation.Min;

    // Group every route by its public slug, preserving first-seen (config/weight)
    // order. Grouping-by-slug for cross-provider window aggregation needs mutation,
    // an early continue, and first-seen ordering, so an imperative Map is clearer
    // than a functional pipeline here.
    const bySlug = new Map<string, ModelRouteCandidate[]>();
    for (const provider of lease.snapshot.providers) {
      if (!provider.enabled) continue;
      for (const route of modelRoutes(provider)) {
        const candidate = { slug: route.alias, modelId: route.modelId, provider };
        const group = bySlug.get(route.alias);
        if (group === undefined) bySlug.set(route.alias, [candidate]);
        else group.push(candidate);
      }
    }

    const slugs = [...bySlug.keys()];
    // metadata is read from the alias slug's own catalog entry, never the
    // upstream modelId, so a single batched lookup keyed by slug suffices.
    const metadataBySlug = slugs.length === 0 ? {} : await getModels(slugs).catch(() => ({}));

    return slugs.map((slug): ResolvedModel => {
      const candidates = bySlug.get(slug)!;
      const metadata = metadataBySlug[slug];
      // The first candidate (config/weight order) supplies the public identity;
      // only the context window aggregates across every provider on this slug.
      const primary = candidates[0]!;
      const contextWindow = aggregateContextWindow(
        candidates.map((candidate) => candidateContextWindow(candidate.provider, candidate.modelId, metadata)),
        aggregation,
      );
      return {
        slug,
        modelId: primary.modelId,
        provider: primary.provider,
        metadata,
        displayName: resolveDisplayName(primary.provider, primary.modelId, slug, metadata),
        contextWindow,
      };
    });
  } finally {
    lease.release();
  }
}
