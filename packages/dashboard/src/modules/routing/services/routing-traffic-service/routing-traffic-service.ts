import type { UsageOverviewRange } from '@aio-proxy/types';
import { queryOptions } from '@tanstack/react-query';
import type { InferResponseType } from 'hono/client';

import { dashboardClient } from '@/lib/dashboard-client';
import { queryKeys } from '@/lib/query-keys';

type RoutingTrafficWire = InferResponseType<typeof dashboardClient.dashboard.api.routing.traffic.$get, 200>;

/**
 * Counts arrive as decimal strings because SQLite integers can exceed the JS safe-integer range,
 * so they are decoded with BigInt the same way `decodeUsageOverview` does. `p95LatencyMs` is
 * passed through as given: `null` means there was no sample, which is a different fact from zero
 * latency.
 */
export const decodeRoutingTraffic = (wire: RoutingTrafficWire) => ({
  ...wire,
  models: wire.models.map((model) => ({
    ...model,
    providers: model.providers.map((provider) => ({
      providerId: provider.providerId,
      finalCount: BigInt(provider.finalCount),
      attemptCount: BigInt(provider.attemptCount),
      successCount: BigInt(provider.successCount),
      p95LatencyMs: provider.p95LatencyMs,
    })),
  })),
});

export type RoutingTrafficData = ReturnType<typeof decodeRoutingTraffic>;
export type RoutingTrafficProviderTotals = RoutingTrafficData['models'][number]['providers'][number];

export const routingTrafficQueryOptions = (range: UsageOverviewRange) =>
  queryOptions({
    queryKey: queryKeys.routingTraffic(range),
    queryFn: async (): Promise<RoutingTrafficData> => {
      const response = await dashboardClient.dashboard.api.routing.traffic.$get({ query: { range } });
      if (!response.ok) throw new Error(`routing traffic failed: ${response.status}`);
      return decodeRoutingTraffic(await response.json());
    },
  });
