import { catalogModelToMetadata, getModels, modelRoutes } from '@aio-proxy/core';
import { ModelContextAggregation, type ModelCapabilities, type ModelLimit, type ModelMetadata } from '@aio-proxy/types';
import { mergeWith } from 'es-toolkit/object';

import type { RuntimeModelMetadata, RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';

export type ResolvedModelCandidate = {
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly configMetadata: ModelMetadata | undefined;
  readonly upstreamMetadata: RuntimeModelMetadata | undefined;
};

export type ResolvedModel = {
  readonly slug: string;
  readonly modelId: string;
  readonly provider: RuntimeProviderInstance;
  readonly candidates: readonly ResolvedModelCandidate[];
  readonly fallbackMetadata: ModelMetadata | undefined;
  readonly aggregation: (typeof ModelContextAggregation)[keyof typeof ModelContextAggregation];
};

export function resolveModelField<T>(
  model: ResolvedModel,
  select: (metadata: ModelMetadata) => T | undefined,
): T | undefined {
  const primary = model.candidates[0]!;
  const read = (metadata: ModelMetadata | undefined) => (metadata === undefined ? undefined : select(metadata));
  return read(primary.configMetadata) ?? read(primary.upstreamMetadata) ?? read(model.fallbackMetadata);
}

export function resolveModelCapabilities(model: ResolvedModel): ModelCapabilities | undefined {
  const primary = model.candidates[0]!;
  const sources = [
    model.fallbackMetadata?.capabilities,
    primary.upstreamMetadata?.capabilities,
    primary.configMetadata?.capabilities,
  ].filter((value): value is ModelCapabilities => value !== undefined);
  if (sources.length === 0) return undefined;

  let resolved: ModelCapabilities = {};
  for (const source of sources) {
    resolved = mergeWith(resolved, source, (_target, sourceValue) =>
      Array.isArray(sourceValue) ? sourceValue : undefined,
    );
  }
  return resolved;
}

export function resolveAggregatedLimit(model: ResolvedModel, field: keyof ModelLimit): number | undefined {
  const values = model.candidates.flatMap((candidate) => {
    const value = [
      candidate.configMetadata?.limit?.[field],
      candidate.upstreamMetadata?.limit?.[field],
      model.fallbackMetadata?.limit?.[field],
    ].find(
      (candidate): candidate is number =>
        typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0,
    );
    return value === undefined ? [] : [value];
  });
  if (values.length === 0) return undefined;
  return model.aggregation === ModelContextAggregation.Max ? Math.max(...values) : Math.min(...values);
}

export async function resolveEnabledModels(state: ServerState): Promise<readonly ResolvedModel[]> {
  const lease = state.acquireProviderSnapshot();
  try {
    const aggregation = lease.snapshot.config?.router.modelContextAggregation ?? ModelContextAggregation.Min;
    const bySlug = new Map<string, ResolvedModelCandidate[]>();
    for (const provider of lease.snapshot.providers) {
      if (!provider.enabled) continue;
      for (const route of modelRoutes(provider)) {
        const candidate: ResolvedModelCandidate = {
          modelId: route.modelId,
          provider,
          configMetadata: provider.configMetadata?.[route.modelId],
          upstreamMetadata: provider.upstreamMetadata?.[route.modelId],
        };
        const group = bySlug.get(route.alias);
        if (group === undefined) bySlug.set(route.alias, [candidate]);
        else group.push(candidate);
      }
    }

    const slugs = [...bySlug.keys()];
    const metadataBySlug = slugs.length === 0 ? {} : await getModels(slugs).catch(() => ({}));

    return slugs.map((slug): ResolvedModel => {
      const candidates = bySlug.get(slug)!;
      const primary = candidates[0]!;
      const fallback = metadataBySlug[slug];
      let fallbackMetadata: ModelMetadata | undefined;
      try {
        fallbackMetadata = fallback === undefined ? undefined : catalogModelToMetadata(fallback);
      } catch {}
      return {
        slug,
        modelId: primary.modelId,
        provider: primary.provider,
        candidates,
        fallbackMetadata,
        aggregation,
      };
    });
  } finally {
    lease.release();
  }
}
