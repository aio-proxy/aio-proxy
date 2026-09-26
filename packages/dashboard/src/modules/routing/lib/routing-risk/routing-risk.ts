import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';
import type { RoutingRiskFilter } from '../routing-search';
import { type RoutingTrafficIndex, modelTrafficSummary, tierActualShares } from '../routing-traffic';

/** Percentage points of divergence, within one tier, before a model is called deviating.
 * Chosen by judgement rather than measurement — tune against real traffic. */
export const DEVIATION_THRESHOLD = 0.15;

/** Below this many served requests the ratio is noise, so no deviation is reported at all. */
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
  const summary = modelTrafficSummary(totals);
  if (summary === undefined || summary.finalCount < DEVIATION_MIN_SAMPLE) return false;
  return model.tiers.some((tier) => {
    const actual = tierActualShares(tier, totals);
    return tier.providers.some((configured) => {
      const observed = actual.find((entry) => entry.providerId === configured.providerId);
      return observed !== undefined && Math.abs(observed.actualShare - configured.share) >= DEVIATION_THRESHOLD;
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
