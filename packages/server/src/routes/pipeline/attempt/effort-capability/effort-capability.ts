import { getModelsCachedOnly, modelEffortValues } from '@aio-proxy/core';
import type { AliasDimensions, ReasoningEffort } from '@aio-proxy/types';

import type { RuntimeModelMetadata } from '../../../../runtime';

// Resolve the effort levels a candidate model advertises. The selected runtime
// provider's own catalog metadata wins: a plugin-backed wire id (e.g. Antigravity's
// `claude-opus-4-6-thinking`) is not a models.dev id, and models.dev would return an
// empty set — which normalizeEffort treats as pass-through, forwarding a level the
// provider rejects. models.dev remains the fallback for API providers that publish
// no capability metadata of their own.
//
// The models.dev read is cached-only: this runs on the request hot path and must
// never trigger or await a network catalog fetch. The catalog is warmed elsewhere
// (e.g. the /v1/models route), so steady-state requests still clamp.
export async function resolveSupportedEfforts(
  modelId: string,
  metadata?: RuntimeModelMetadata,
): Promise<ReadonlySet<string>> {
  const advertised = runtimeEffortValues(metadata);
  if (advertised.size > 0) return advertised;
  try {
    const models = await getModelsCachedOnly([modelId]);
    return modelEffortValues(models[modelId]);
  } catch {
    return new Set();
  }
}

// When the inbound request carries no effort, there is nothing to clamp and
// the capability lookup is pure overhead — short-circuit before touching it.
export async function resolveSupportedEffortsForDimensions(
  dimensions: AliasDimensions,
  modelId: string,
  metadata?: RuntimeModelMetadata,
): Promise<ReadonlySet<string>> {
  if (dimensions.effort === undefined) return new Set();
  return resolveSupportedEfforts(modelId, metadata);
}

// Reads the camelCased ModelMetadata shape (mirrors toAnthropicCapabilitiesFromMetadata).
// `null` means "reasoning can be disabled" and `default` is a placeholder; neither is a
// clampable ladder level, so both are dropped.
function runtimeEffortValues(metadata: RuntimeModelMetadata | undefined): ReadonlySet<string> {
  const option = metadata?.capabilities?.reasoningOptions?.find((entry) => entry.type === 'effort');
  if (option === undefined) return new Set();
  return new Set(
    option.values.filter((value): value is NonNullable<ReasoningEffort> => value !== null && value !== 'default'),
  );
}
