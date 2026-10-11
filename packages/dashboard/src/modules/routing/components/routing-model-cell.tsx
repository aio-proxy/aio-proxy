import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, RouterSelection } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import type React from 'react';

import { modelRisks } from '../lib/routing-risk';
import type { RoutingTrafficProviderTotals } from '../services/routing-traffic-service';
import { RoutingRiskBadge } from './routing-risk-badge';

interface RoutingModelCellProps {
  readonly model: DashboardRoutingModel;
  readonly totals: readonly RoutingTrafficProviderTotals[] | undefined;
  readonly selection?: RouterSelection;
}

export const RoutingModelCell: React.FC<RoutingModelCellProps> = ({ model, totals, selection }) => {
  const risks = modelRisks(model, totals, selection);
  // The count only earns its place when something is missing; a full house is the normal case.
  const partial = model.eligibleProviderCount < model.providerCount;

  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <span className="font-mono text-sm break-all">{model.modelId}</span>
      {risks.length === 0 && !partial && !model.hasOverrides ? null : (
        <div className="flex flex-wrap items-center gap-1.5">
          {risks.map((risk) => (
            <RoutingRiskBadge key={risk} risk={risk} />
          ))}
          {/* Overrides are the exception, so they are marked here rather than given a column of their own. */}
          {model.hasOverrides ? (
            <Badge variant="secondary" className="text-xs">
              {m['dashboard.routing.table.overrides_yes']()}
            </Badge>
          ) : null}
          {partial ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {m['dashboard.routing.table.available']({
                eligible: model.eligibleProviderCount,
                known: model.providerCount,
              })}
            </span>
          ) : null}
        </div>
      )}
    </div>
  );
};
