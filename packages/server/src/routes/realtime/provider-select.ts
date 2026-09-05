import type { RealtimeTransport } from '@aio-proxy/plugin-sdk';
import { ROUTING_VALUE_MAX } from '@aio-proxy/types';

import type { ProviderRouteSnapshot, RuntimeProviderInstance } from '../../runtime';

const DEFAULT_PRIORITY = 0;
const DEFAULT_WEIGHT = 1;

export type RealtimeCandidate = {
  readonly provider: RuntimeProviderInstance;
  readonly realtime: RealtimeTransport;
  readonly priority: number;
  readonly weight: number;
};

export type RealtimeModelPair = { readonly requested: string; readonly normalized: string };

export type RealtimeCallPin = {
  readonly providerId: string;
  readonly accountId: string;
  readonly runtimeRevision: number;
};

export function selectRealtimeCandidates(
  snapshot: ProviderRouteSnapshot,
  models: RealtimeModelPair,
): readonly RealtimeCandidate[] {
  const candidates: RealtimeCandidate[] = [];
  for (const provider of snapshot.providers) {
    const candidate = eligibleCandidate(snapshot, provider, models);
    if (candidate !== undefined) candidates.push(candidate);
  }
  // Deterministic in this phase: no weighted draw. Weight still orders, and a
  // zero effective weight still removes a candidate — that is eligibility, not
  // distribution.
  return candidates.sort((left, right) => {
    if (left.priority !== right.priority) return right.priority - left.priority;
    if (left.weight !== right.weight) return right.weight - left.weight;
    return left.provider.id < right.provider.id ? -1 : left.provider.id > right.provider.id ? 1 : 0;
  });
}

export function pinnedRealtimeCandidate(
  snapshot: ProviderRouteSnapshot,
  pin: RealtimeCallPin,
): RealtimeCandidate | undefined {
  const provider = snapshot.providers.find(({ id }) => id === pin.providerId);
  if (provider === undefined || provider.enabled === false) return undefined;
  if (provider.accountId !== pin.accountId || provider.runtimeRevision !== pin.runtimeRevision) return undefined;
  const realtime = provider.realtime;
  if (realtime === undefined) return undefined;
  return {
    provider,
    realtime,
    priority: provider.priority ?? DEFAULT_PRIORITY,
    weight: effectiveWeight(snapshot, provider, undefined),
  };
}

function eligibleCandidate(
  snapshot: ProviderRouteSnapshot,
  provider: RuntimeProviderInstance,
  models: RealtimeModelPair,
): RealtimeCandidate | undefined {
  if (provider.enabled === false) return undefined;
  const realtime = provider.realtime;
  if (realtime === undefined || !realtime.models.includes(models.normalized)) return undefined;
  if (isExcluded(snapshot, provider, models)) return undefined;
  const weight = effectiveWeight(snapshot, provider, models.normalized);
  if (weight <= 0) return undefined;
  return { provider, realtime, priority: provider.priority ?? DEFAULT_PRIORITY, weight };
}

// `excludedModels` is authored on the config `OAuthProvider`
// (`packages/types/src/provider.ts:112`) and is NOT copied onto
// `RuntimeProviderBase`, so it must be read back out of the snapshot's config.
// Both ids are checked because they differ: excluding `gpt-realtime` must take
// effect even though selection matches on `gpt-live-1-codex`.
function isExcluded(
  snapshot: ProviderRouteSnapshot,
  provider: RuntimeProviderInstance,
  models: RealtimeModelPair,
): boolean {
  const configured = snapshot.config?.providers.find(({ id }) => id === provider.id);
  const excluded = configured !== undefined && 'excludedModels' in configured ? configured.excludedModels : undefined;
  if (excluded === undefined || excluded.length === 0) return false;
  return excluded.includes(models.requested) || excluded.includes(models.normalized);
}

// Same rule as the router: authored provider weight defaults to 1, a model
// override replaces it wholesale, then `Math.round` and clamp to
// 0..ROUTING_VALUE_MAX.
function effectiveWeight(
  snapshot: ProviderRouteSnapshot,
  provider: RuntimeProviderInstance,
  model: string | undefined,
): number {
  const authored = provider.weight ?? DEFAULT_WEIGHT;
  const override =
    model === undefined ? undefined : snapshot.config?.router.models[model]?.providers[provider.id]?.weight;
  const value = override ?? authored;
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), ROUTING_VALUE_MAX);
}
