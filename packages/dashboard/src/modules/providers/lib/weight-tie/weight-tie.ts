import type { DashboardProviderSummary } from '@aio-proxy/types';

/**
 * What the tie predicate needs, and deliberately no more. The rows come straight from
 * `providersQueryOptions()`, so the element type stays the narrow `Pick` the summaries satisfy rather
 * than a full `DashboardProviderSummary`.
 */
export interface WeightTieInput {
  readonly selfId: string;
  readonly selfWeight: number | undefined;
  readonly exposedAliases: readonly string[];
  readonly others: readonly Pick<DashboardProviderSummary, 'id' | 'weight' | 'clientModels' | 'enabled'>[];
}

// Absent coalesces to 1 at the schema default; matched here so a tie is judged by the same yardstick.
const effectiveWeight = (weight: number | undefined): number => weight ?? 1;

/**
 * Does another materialized provider share this one's weight on an alias they both serve? Feeds
 * `sectionStatuses` as `weightTie`; the predicate must exist exactly once.
 *
 * A disabled other is never materialized (materialize.ts:137-140 records a summary and continues), so
 * a tie against it is a conflict that cannot happen. Self is excluded by id rather than by shape: the
 * summaries list includes the provider being edited, whose stored row is stale against the live form.
 */
export const hasWeightTie = ({ selfId, selfWeight, exposedAliases, others }: WeightTieInput): boolean =>
  others.some(
    (provider) =>
      provider.id !== selfId &&
      provider.enabled &&
      effectiveWeight(provider.weight) === effectiveWeight(selfWeight) &&
      provider.clientModels.some((alias) => exposedAliases.includes(alias)),
  );
