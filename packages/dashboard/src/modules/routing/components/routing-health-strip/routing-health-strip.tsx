import { m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import type { RoutingRiskCounts } from '../../lib/routing-risk';
import { ROUTING_RISK_FILTERS, type RoutingRiskFilter } from '../../lib/routing-search';

const numberFormatter = new Intl.NumberFormat();

const formatCount = (value: number) => numberFormatter.format(value);

const riskLabel = (risk: RoutingRiskFilter) => {
  switch (risk) {
    case 'no-eligible':
      return m['dashboard.routing.health.no_eligible']();
    case 'single-point':
      return m['dashboard.routing.health.single_point']();
    case 'deviating':
      return m['dashboard.routing.health.deviating']();
  }
};

interface RoutingHealthStripProps {
  readonly total: number;
  readonly counts: RoutingRiskCounts;
  readonly active: RoutingRiskFilter | undefined;
  /** The traffic query failed with nothing to fall back on, so deviation cannot be reported at all. */
  readonly trafficUnavailable: boolean;
  readonly onToggle: (risk: RoutingRiskFilter) => void;
}

export const RoutingHealthStrip: React.FC<RoutingHealthStripProps> = ({
  total,
  counts,
  active,
  trafficUnavailable,
  onToggle,
}) => (
  <div data-testid="routing-health-strip" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
    <Card size="sm">
      <CardHeader>
        <CardTitle>{m['dashboard.routing.health.total']()}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="font-heading text-2xl font-semibold tabular-nums">{formatCount(total)}</div>
      </CardContent>
    </Card>
    {ROUTING_RISK_FILTERS.map((risk) => {
      // Deviation is the only risk that needs traffic. With no traffic to measure, the tile is
      // dropped rather than shown: `0` would claim nothing diverged, and a permanent "measuring"
      // would promise a result that is never coming.
      if (risk === 'deviating' && trafficUnavailable) return null;
      const deviatingPending = risk === 'deviating' && counts.deviating === undefined;
      const pressed = active === risk;
      const value = counts[risk];

      return (
        <Card
          key={risk}
          size="sm"
          render={
            <button type="button" disabled={deviatingPending} aria-pressed={pressed} onClick={() => onToggle(risk)} />
          }
          className={cn(
            'min-h-24 cursor-pointer border-0 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50',
            pressed && 'bg-muted ring-2 ring-primary',
          )}
        >
          <CardHeader>
            <CardTitle>{riskLabel(risk)}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-heading text-2xl font-semibold tabular-nums">
              {deviatingPending ? m['dashboard.routing.health.deviating_pending']() : formatCount(value as number)}
            </div>
          </CardContent>
        </Card>
      );
    })}
  </div>
);
