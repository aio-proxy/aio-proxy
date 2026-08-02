import { getModelsCachedOnly, modelEffortValues } from '@aio-proxy/core';

// Resolve the effort levels a candidate model advertises, using ONLY cached
// capability data. This runs on the request hot path, so it must never trigger
// or await a network catalog fetch: a cold or slow models.dev yields an empty
// set, which normalizeEffort treats as pass-through. The catalog is warmed
// elsewhere (e.g. the /v1/models route), so steady-state requests still clamp.
export async function resolveSupportedEfforts(modelId: string): Promise<ReadonlySet<string>> {
  try {
    const models = await getModelsCachedOnly([modelId]);
    return modelEffortValues(models[modelId]);
  } catch {
    return new Set();
  }
}
