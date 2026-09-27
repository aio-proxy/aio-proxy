import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';
import type { RoutingRiskFilter } from '../routing-search';
import { type RoutingTrafficIndex, tierActualShares } from '../routing-traffic';

/** Percentage points of divergence, within one tier, before a model is called deviating.
 * Chosen by judgement rather than measurement — tune against real traffic. */
export const DEVIATION_THRESHOLD = 0.15;

/** Requests a single tier must have served before its split is judged. Below this the ratio is
 * noise. Gated per tier rather than per model because the shares being compared are per tier: a
 * busy primary tier would otherwise lend its sample to a fallback tier that saw one request. */
export const DEVIATION_MIN_SAMPLE = 50n;

/** Risks derivable from configuration alone, so they are available the moment the list renders. */
export const configuredRisks = (model: DashboardRoutingModel): readonly RoutingRiskFilter[] => {
  if (model.eligibleProviderCount === 0) return ['no-eligible'];
  if (model.eligibleProviderCount === 1) return ['single-point'];
  return [];
};

/** `undefined` means unknown — traffic has not arrived or failed. Never conflate that with
 * `false`, which would claim the model is behaving as configured. */
export const isDeviating = (
  model: DashboardRoutingModel,
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): boolean | undefined => {
  if (totals === undefined) return undefined;
  return model.tiers.some((tier) => {
    const actual = tierActualShares(tier, totals);
    // A tier that served nothing falls out here too: an unused tier adds no observation and is
    // not a bad split.
    if (actual.reduce((sum, entry) => sum + entry.finalCount, 0n) < DEVIATION_MIN_SAMPLE) return false;
    return tier.providers.some((configured) => {
      const observed = actual.find((entry) => entry.providerId === configured.providerId);
      // The query omits providers with no spans, so a silent provider inside an active tier is a
      // measured zero rather than a missing observation.
      const actualShare = observed?.actualShare ?? 0;
      return Math.abs(actualShare - configured.share) >= DEVIATION_THRESHOLD;
    });
  });
};

export const modelRisks = (
  model: DashboardRoutingModel,
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
): readonly RoutingRiskFilter[] =>
  isDeviating(model, totals) === true ? [...configuredRisks(model), 'deviating'] : configuredRisks(model);

export type RoutingRiskCounts = {
  readonly 'no-eligible': number;
  readonly 'single-point': number;
  /** `undefined` while traffic is unknown, so the tile can show a loading state instead of 0. */
  readonly deviating: number | undefined;
};

export const countRoutingRisks = (
  models: readonly DashboardRoutingModel[],
  index: RoutingTrafficIndex | undefined,
): RoutingRiskCounts => ({
  'no-eligible': models.filter((model) => model.eligibleProviderCount === 0).length,
  'single-point': models.filter((model) => model.eligibleProviderCount === 1).length,
  deviating:
    index === undefined
      ? undefined
      : models.filter((model) => isDeviating(model, index.get(model.modelId)) === true).length,
});
