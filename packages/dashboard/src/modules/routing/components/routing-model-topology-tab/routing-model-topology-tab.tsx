import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { useRoutingForm } from '../../hooks/use-routing-form';
import type { RoutingTierShare } from '../../lib/routing-traffic';
import { RoutingBoard } from '../routing-board';

export interface RoutingModelTopologyTabProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly actual: readonly RoutingTierShare[] | undefined;
}

export const RoutingModelTopologyTab: React.FC<RoutingModelTopologyTabProps> = ({ form, model, writable, actual }) => (
  <div className="space-y-2">
    {actual === undefined ? (
      <p className="text-sm text-muted-foreground">{m['dashboard.routing.detail.no_traffic_yet']()}</p>
    ) : null}
    <RoutingBoard form={form} model={model} writable={writable} actual={actual} />
  </div>
);
