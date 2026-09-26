import { UsageOverviewRangeSchema } from '@aio-proxy/types';
import { z } from 'zod';

/** The three risks the health strip can filter by. Ordered as the strip renders them. */
export const ROUTING_RISK_FILTERS = ['no-eligible', 'single-point', 'deviating'] as const;

export type RoutingRiskFilter = (typeof ROUTING_RISK_FILTERS)[number];

// Every field catches: a hand-edited or stale URL must degrade to "no filter" rather than
// throwing, which would blank the route instead of showing an unfiltered list.
export const routingSearchSchema = z.object({
  risk: z.enum(ROUTING_RISK_FILTERS).optional().catch(undefined),
  lab: z.string().trim().min(1).optional().catch(undefined),
  range: UsageOverviewRangeSchema.catch('24h'),
});

export type RoutingSearch = z.output<typeof routingSearchSchema>;

export type RoutingFilterPatch = {
  readonly [Key in keyof RoutingSearch]?: RoutingSearch[Key] | undefined;
};

/** Clearing a filter means removing the key, so `stripSearchParams` keeps it out of the URL. */
export const withRoutingFilters = (search: RoutingSearch, patch: RoutingFilterPatch): RoutingSearch => {
  const next: Record<string, unknown> = { ...search, ...patch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete next[key];
  }
  return next as RoutingSearch;
};

/** Clicking the active tile clears the filter; clicking another replaces it. */
export const toggleRoutingRisk = (search: RoutingSearch, risk: RoutingRiskFilter): RoutingSearch =>
  withRoutingFilters(search, { risk: search.risk === risk ? undefined : risk });
