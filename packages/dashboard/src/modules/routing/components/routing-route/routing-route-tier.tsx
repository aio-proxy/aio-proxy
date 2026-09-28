import type { DashboardRoutingModel } from '@aio-proxy/types';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { RoutingTierLabel } from '@/components/routing-tier-label';

import { tierDeviations } from '../../lib/routing-risk';
import { formatTierShares } from '../../lib/routing-summary';
import { tierActualShares } from '../../lib/routing-traffic';
import type { RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';
import { RoutingRouteProvider } from './routing-route-provider';

const SEGMENT_CLASSES = ['bg-chart-1', 'bg-chart-2', 'bg-chart-3', 'bg-chart-4', 'bg-chart-5'] as const;
const segmentClass = (index: number): string => SEGMENT_CLASSES[index % SEGMENT_CLASSES.length] ?? 'bg-chart-1';

interface RoutingRouteTierProps {
  readonly index: number;
  readonly tier: DashboardRoutingModel['tiers'][number];
  readonly providers: DashboardRoutingModel['providers'];
  readonly totals: readonly RoutingTrafficProviderTotals[] | undefined;
}

export const RoutingRouteTier: React.FC<RoutingRouteTierProps> = ({ index, tier, providers, totals }) => {
  const split = tier.providers.length > 1;
  const labels = formatTierShares(tier.providers.map((entry) => entry.share));
  // Walk `tier.providers` for the measured bar too, so segment N is the same Provider in both bars.
  // A Provider that served nothing is absent from the traffic rows but is a measured zero here.
  const measured = tierActualShares(tier, totals);
  const actual =
    measured.length === 0
      ? undefined
      : tier.providers.map((entry) => measured.find((row) => row.providerId === entry.providerId)?.actualShare ?? 0);
  const deviations = tierDeviations(tier, totals);

  return (
    <div
      data-testid={`routing-tier-${index + 1}`}
      className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-2.5"
    >
      <RoutingTierLabel tier={index + 1} priority={tier.priority} className="mt-1" />
      <div className="flex min-w-0 flex-col gap-1.5">
        {/* One Provider per line; the swatch in each label matches its segment in the bar below. */}
        <div className="flex min-w-0 flex-col items-start gap-1.5">
          {tier.providers.map((entry, providerIndex) => (
            <RoutingRouteProvider
              key={entry.providerId}
              providerId={entry.providerId}
              routing={providers.find((provider) => provider.id === entry.providerId)}
              share={
                split
                  ? {
                      label: labels[providerIndex] ?? '',
                      swatchClassName: segmentClass(providerIndex),
                      actual: actual?.[providerIndex],
                      deviation: deviations.get(entry.providerId),
                    }
                  : undefined
              }
            />
          ))}
        </div>
        {split ? (
          <div aria-hidden="true" className="flex h-1 max-w-xl gap-0.5">
            {tier.providers.map((entry, providerIndex) => (
              <span
                key={entry.providerId}
                // A floor width keeps a <1% candidate visible instead of collapsing to nothing.
                className={cn('min-w-0.5 basis-0 rounded-full', segmentClass(providerIndex))}
                style={{ flexGrow: entry.share }}
              />
            ))}
          </div>
        ) : null}
        {split && actual !== undefined ? (
          <div aria-hidden="true" data-testid="routing-tier-actual" className="flex h-0.5 max-w-xl gap-0.5">
            {tier.providers.map((entry, providerIndex) => (
              <span
                key={entry.providerId}
                className={cn(
                  'basis-0 rounded-full',
                  deviations.has(entry.providerId) ? 'bg-destructive' : segmentClass(providerIndex),
                )}
                style={{ flexGrow: actual[providerIndex] ?? 0 }}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
};
