import { m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent } from '@aio-proxy/ui/components/card';
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
  readonly onToggle: (risk: RoutingRiskFilter) => void;
}

export const RoutingHealthStrip: React.FC<RoutingHealthStripProps> = ({ total, counts, active, onToggle }) => (
  <Card>
    <CardContent className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
      <div className="flex flex-col gap-1 rounded-lg border bg-card p-3">
        <span className="text-sm text-muted-foreground">{m['dashboard.routing.health.total']()}</span>
        <span className="text-2xl font-semibold tabular-nums">{formatCount(total)}</span>
      </div>
      {ROUTING_RISK_FILTERS.map((risk) => {
        const deviatingPending = risk === 'deviating' && counts.deviating === undefined;
        const pressed = active === risk;
        const value = counts[risk];

        return (
          <Button
            key={risk}
            type="button"
            variant="ghost"
            disabled={deviatingPending}
            aria-pressed={pressed}
            className={cn(
              'h-auto flex-col items-start gap-1 rounded-lg border p-3 text-left font-normal',
              pressed && 'border-primary bg-muted',
            )}
            onClick={() => onToggle(risk)}
          >
            <span className="text-sm text-muted-foreground">{riskLabel(risk)}</span>
            <span className="text-2xl font-semibold tabular-nums">
              {deviatingPending ? m['dashboard.routing.health.deviating_pending']() : formatCount(value as number)}
            </span>
          </Button>
        );
      })}
    </CardContent>
  </Card>
);
