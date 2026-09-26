import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { RoutingTrafficData, RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';

export type RoutingTrafficIndex = ReadonlyMap<string, readonly RoutingTrafficProviderTotals[]>;

export type RoutingTierShare = {
  readonly providerId: string;
  /** finalCount over the tier's own total. Comparable with the configured `share`. */
  readonly actualShare: number;
  /** successCount / attemptCount. `null` when nothing was attempted — unknown, not zero. */
  readonly successRate: number | null;
  readonly p95LatencyMs: number | null;
  readonly finalCount: bigint;
};

export type RoutingTrafficSummary = {
  readonly finalCount: bigint;
  readonly attemptCount: bigint;
  readonly successCount: bigint;
  readonly successRate: number | null;
};

/** Keyed by the traffic response's `modelId`, which is `requested_model_id` — a different key
 * space from the routing inventory in both directions. Callers look models up by inventory id,
 * so a traffic row the inventory no longer serves simply never matches and never reaches a
 * denominator. Counting it would corrupt every share on the page. */
export const indexRoutingTraffic = (traffic: RoutingTrafficData): RoutingTrafficIndex =>
  new Map(traffic.models.map((model) => [model.modelId, model.providers]));

const rate = (numerator: bigint, denominator: bigint): number | null =>
  denominator === 0n ? null : Number(numerator) / Number(denominator);

/** Actual share is computed over the tier's own members, matching the denominator the configured
 * share already uses. Taking it over the whole model would let a tier-2 fallback dilute tier 1. */
export const tierActualShares = (
  tier: DashboardRoutingModel['tiers'][number],
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): readonly RoutingTierShare[] => {
  if (totals === undefined) return [];
  const members = tier.providers.flatMap((entry) => {
    const found = totals.find((row) => row.providerId === entry.providerId);
    return found === undefined ? [] : [found];
  });
  const denominator = members.reduce((sum, row) => sum + row.finalCount, 0n);
  return members.map((row) => ({
    providerId: row.providerId,
    actualShare: denominator === 0n ? 0 : Number(row.finalCount) / Number(denominator),
    successRate: rate(row.successCount, row.attemptCount),
    p95LatencyMs: row.p95LatencyMs,
    finalCount: row.finalCount,
  }));
};

/** Whole-model totals for the list's traffic column. `undefined` means no traffic at all, which
 * the column renders as "no traffic" rather than as zeros. */
export const modelTrafficSummary = (
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): RoutingTrafficSummary | undefined => {
  if (totals === undefined) return undefined;
  const finalCount = totals.reduce((sum, row) => sum + row.finalCount, 0n);
  const attemptCount = totals.reduce((sum, row) => sum + row.attemptCount, 0n);
  const successCount = totals.reduce((sum, row) => sum + row.successCount, 0n);
  return { finalCount, attemptCount, successCount, successRate: rate(successCount, attemptCount) };
};
