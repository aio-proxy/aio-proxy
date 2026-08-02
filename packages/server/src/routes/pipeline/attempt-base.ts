import { configModelPrice, type OpenRouterModelPrice } from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';

export type AttemptTraceMetadata = {
  readonly providerWeight?: number | undefined;
  readonly transport?: 'raw' | 'ai_sdk' | undefined;
  readonly sourceProtocol: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol | undefined;
  readonly selectionReason: 'response_owner' | 'affinity' | 'weight';
};

// Controlled facts about a single provider attempt, shared by the failure
// shaping helpers and the attempt-span emitter. Independent of the recorder.
export type AttemptInfo = AttemptTraceMetadata & {
  readonly providerId: string;
  readonly modelId: string;
  readonly providerKind: RuntimeProviderInstance['kind'];
  readonly protocol?: ProviderProtocol;
  readonly durationMs: number;
};

export function attemptBase(
  provider: RuntimeProviderInstance,
  modelId: string,
  startedAt: number,
  metadata: AttemptTraceMetadata,
): AttemptInfo {
  return {
    ...metadata,
    providerId: provider.id,
    modelId,
    providerKind: provider.kind,
    ...(metadata.targetProtocol === undefined ? {} : { protocol: metadata.targetProtocol }),
    durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
  };
}

// The hit channel's per-model config cost override, mapped into the pricing
// engine's shape. Undefined when the provider declares no cost for this model,
// so billing falls back to the models.dev catalog.
export function candidateConfigPrice(
  provider: RuntimeProviderInstance,
  modelId: string,
): OpenRouterModelPrice | undefined {
  const cost = provider.metadata?.[modelId]?.cost;
  return cost === undefined ? undefined : configModelPrice(modelId, cost);
}
