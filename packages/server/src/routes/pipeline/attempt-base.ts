import { configModelPrice, type OpenRouterModelPrice, type RouterCandidate } from '@aio-proxy/core';
import type { ProviderProtocol } from '@aio-proxy/types';

import { attributeName } from '../../request-tracing';
import type { RuntimeProviderInstance } from '../../runtime';

export type AttemptSelectionSource =
  | 'provider_qualified'
  | 'response_owner'
  | 'session_affinity'
  | 'deterministic_session'
  | 'weighted_random';

export type AttemptTraceMetadata = {
  readonly routingContractVersion: 2;
  readonly providerWeight: number;
  readonly effectivePriority: number;
  readonly effectiveWeight: number;
  readonly prioritySource: 'provider' | 'model';
  readonly weightSource: 'provider' | 'model';
  readonly selectionSource: AttemptSelectionSource;
  readonly transport?: 'raw' | 'ai_sdk' | 'image' | undefined;
  readonly sourceProtocol: ProviderProtocol;
  readonly targetProtocol?: ProviderProtocol | undefined;
  readonly selectionReason: 'response_owner' | 'affinity' | 'weight';
};

const PROVIDER_DEFAULT_WEIGHT = 1;

export type CandidateSelectionResolution = {
  readonly affinity?: { readonly active: boolean; readonly providerId: string };
  readonly responseOwner?: { readonly providerId: string };
};

export function candidateSelectionSource(
  candidate: RouterCandidate<RuntimeProviderInstance>,
  resolution: CandidateSelectionResolution,
): AttemptSelectionSource {
  const providerId = candidate.provider.id;
  if (resolution.responseOwner?.providerId === providerId) return 'response_owner';
  if (resolution.affinity?.active === true && resolution.affinity.providerId === providerId) return 'session_affinity';
  return candidate.selectionSource;
}

export function candidateRoutingTrace(
  candidate: RouterCandidate<RuntimeProviderInstance>,
  selectionSource: AttemptSelectionSource,
): Pick<
  AttemptTraceMetadata,
  | 'routingContractVersion'
  | 'providerWeight'
  | 'effectivePriority'
  | 'effectiveWeight'
  | 'prioritySource'
  | 'weightSource'
  | 'selectionSource'
> {
  return {
    routingContractVersion: 2,
    providerWeight: candidate.provider.weight ?? PROVIDER_DEFAULT_WEIGHT,
    effectivePriority: candidate.routing.priority,
    effectiveWeight: candidate.routing.weight,
    prioritySource: candidate.routing.prioritySource,
    weightSource: candidate.routing.weightSource,
    selectionSource,
  };
}

export function routingSpanAttributes(
  metadata: ReturnType<typeof candidateRoutingTrace>,
): Record<string, string | number> {
  return {
    [attributeName.routingContractVersion]: metadata.routingContractVersion,
    [attributeName.providerWeight]: metadata.providerWeight,
    [attributeName.effectivePriority]: metadata.effectivePriority,
    [attributeName.effectiveWeight]: metadata.effectiveWeight,
    [attributeName.prioritySource]: metadata.prioritySource,
    [attributeName.weightSource]: metadata.weightSource,
    [attributeName.selectionSource]: metadata.selectionSource,
  };
}

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
  const cost = provider.configMetadata?.[modelId]?.cost;
  return cost === undefined ? undefined : configModelPrice(modelId, cost);
}
