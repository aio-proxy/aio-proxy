import type { DashboardRoutingModel, RouterSelection } from '@aio-proxy/types';

import type { RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';
import { tierActualShares } from '../routing-traffic';

/** Only what needs acting on. A single eligible Provider is the norm, not a risk: most models are
 * served by one upstream and there is no second one to add. */
export type RoutingRisk = 'no-eligible' | 'deviating';

/** Percentage points of divergence, within one tier, before a model is called deviating.
 * Chosen by judgement rather than measurement — tune against real traffic. */
export const DEVIATION_THRESHOLD = 0.15;

/** Requests a single tier must have served before its split is judged. Below this the ratio is
 * noise. Gated per tier rather than per model because the shares being compared are per tier: a
 * busy primary tier would otherwise lend its sample to a fallback tier that saw one request. */
export const DEVIATION_MIN_SAMPLE = 50n;

/** Risks derivable from configuration alone, so they are available the moment the list renders. */
export const configuredRisks = (model: DashboardRoutingModel): readonly RoutingRisk[] => {
  if (model.eligibleProviderCount === 0) return ['no-eligible'];
  return [];
};

/** Providers in one tier whose measured share ran at least `DEVIATION_THRESHOLD` from the
 * configured one, mapped to that measured share. Empty below the tier's sample floor. */
export const tierDeviations = (
  tier: DashboardRoutingModel['tiers'][number],
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
  selection: RouterSelection = 'weighted',
): ReadonlyMap<string, number> => {
  const deviations = new Map<string, number>();
  // Quota-reset ordering lets one subscription carry its tier until it runs out, so the weight split
  // predicts nothing there and a lopsided tier is the policy working, not a misconfiguration.
  if (totals === undefined || selection === 'quota-reset') return deviations;
  const actual = tierActualShares(tier, totals);
  // A tier that served nothing falls out here too: an unused tier adds no observation and is
  // not a bad split.
  if (actual.reduce((sum, entry) => sum + entry.finalCount, 0n) < DEVIATION_MIN_SAMPLE) return deviations;
  for (const configured of tier.providers) {
    // The query omits providers with no spans, so a silent provider inside an active tier is a
    // measured zero rather than a missing observation.
    const actualShare = actual.find((entry) => entry.providerId === configured.providerId)?.actualShare ?? 0;
    if (Math.abs(actualShare - configured.share) >= DEVIATION_THRESHOLD) {
      deviations.set(configured.providerId, actualShare);
    }
  }
  return deviations;
};

/** `undefined` means unknown — traffic has not arrived or failed. Never conflate that with
 * `false`, which would claim the model is behaving as configured. */
export const isDeviating = (
  model: DashboardRoutingModel,
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
  selection: RouterSelection = 'weighted',
): boolean | undefined => {
  if (totals === undefined) return undefined;
  return model.tiers.some((tier) => tierDeviations(tier, totals, selection).size > 0);
};

export const modelRisks = (
  model: DashboardRoutingModel,
  totals: readonly RoutingTrafficProviderTotals[] | undefined,
  selection: RouterSelection = 'weighted',
): readonly RoutingRisk[] =>
  isDeviating(model, totals, selection) === true ? [...configuredRisks(model), 'deviating'] : configuredRisks(model);
