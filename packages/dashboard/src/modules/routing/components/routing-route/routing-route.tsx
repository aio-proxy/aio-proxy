import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import type React from 'react';

import type { RoutingTrafficProviderTotals } from '../../services/routing-traffic-service';
import { RoutingRouteIneligible } from './routing-route-ineligible';
import { RoutingRouteTier } from './routing-route-tier';

interface RoutingRouteProps {
  readonly model: DashboardRoutingModel;
  /** `undefined` while traffic is unknown; the measured bars are withheld rather than drawn as zero. */
  readonly totals: readonly RoutingTrafficProviderTotals[] | undefined;
}

/** One row per failover tier, `T1` first, then the Providers that take no traffic. */
export const RoutingRoute: React.FC<RoutingRouteProps> = ({ model, totals }) => {
  const ineligible = model.providers.filter((provider) => !provider.effective.eligible);
  if (model.tiers.length === 0 && ineligible.length === 0) {
    return <span className="text-sm text-muted-foreground">{m['dashboard.routing.table.disabled']()}</span>;
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {model.tiers.map((tier, index) => (
        <RoutingRouteTier key={tier.priority} index={index} tier={tier} providers={model.providers} totals={totals} />
      ))}
      {ineligible.length === 0 ? null : <RoutingRouteIneligible providers={ineligible} />}
    </div>
  );
};
