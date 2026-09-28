import { m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';
import type React from 'react';

import type { RoutingRisk } from '../lib/routing-risk';

const riskLabel = (risk: RoutingRisk): string => {
  switch (risk) {
    case 'no-eligible':
      return m['dashboard.routing.risk.no_eligible']();
    case 'deviating':
      return m['dashboard.routing.risk.deviating']();
  }
};

interface RoutingRiskBadgeProps {
  readonly risk: RoutingRisk;
}

/** A model with no eligible Provider cannot serve at all, so only that risk takes the destructive tone. */
export const RoutingRiskBadge: React.FC<RoutingRiskBadgeProps> = ({ risk }) => (
  <Badge variant={risk === 'no-eligible' ? 'destructive' : 'outline'} className="text-xs">
    {riskLabel(risk)}
  </Badge>
);
