import { UsageOverviewRangeSchema } from '@aio-proxy/types';
import { omitBy } from 'es-toolkit/object';
import { isUndefined } from 'es-toolkit/predicate';
import { z } from 'zod';

// Every field catches: a hand-edited or stale URL must degrade to "no filter" rather than
// throwing, which would blank the route instead of showing an unfiltered list.
export const routingSearchSchema = z.object({
  lab: z.string().trim().min(1).optional().catch(undefined),
  range: UsageOverviewRangeSchema.catch('24h'),
});

export type RoutingSearch = z.output<typeof routingSearchSchema>;

export type RoutingFilterPatch = {
  readonly [Key in keyof RoutingSearch]?: RoutingSearch[Key] | undefined;
};

/**
 * Clearing a filter means removing the key, so `stripSearchParams` keeps it out of the URL.
 * Dropping every undefined value also discards a key Zod cleared while catching a malformed
 * inbound URL, so junk cannot round-trip.
 */
export const withRoutingFilters = (search: RoutingSearch, patch: RoutingFilterPatch): RoutingSearch =>
  omitBy({ ...search, ...patch }, isUndefined) as RoutingSearch;
