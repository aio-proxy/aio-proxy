import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingProvider } from '@aio-proxy/types';
import type React from 'react';

import { RoutingTierMarker } from '@/components/routing-tier-label';

import { RoutingRouteProvider } from './routing-route-provider';

// Checked in the order a user would fix them: a disabled Provider stays out whatever its weight.
const ineligibleReason = (provider: DashboardRoutingProvider): string => {
  if (!provider.enabled) return m['dashboard.routing.route.off_disabled']();
  if (provider.state.status !== 'ready') return m['dashboard.routing.route.off_unavailable']();
  if (provider.effective.weight === 0) return m['dashboard.routing.route.off_zero_weight']();
  return m['dashboard.routing.route.ineligible']();
};

interface RoutingRouteIneligibleProps {
  readonly providers: readonly DashboardRoutingProvider[];
}

/** Providers that serve this model but take no traffic, kept visible so the list explains a missing candidate. */
export const RoutingRouteIneligible: React.FC<RoutingRouteIneligibleProps> = ({ providers }) => (
  <div
    data-testid="routing-tier-ineligible"
    className="grid min-w-0 grid-cols-[2rem_minmax(0,1fr)] items-start gap-2.5"
  >
    <RoutingTierMarker variant="ineligible" className="mt-1" tooltip={m['dashboard.routing.route.ineligible']()}>
      —
    </RoutingTierMarker>
    <div className="flex min-w-0 flex-wrap gap-1.5">
      {providers.map((provider) => (
        <RoutingRouteProvider
          key={provider.id}
          providerId={provider.id}
          routing={provider}
          ineligibleReason={ineligibleReason(provider)}
        />
      ))}
    </div>
  </div>
);
