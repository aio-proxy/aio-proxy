import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { useRoutingForm } from '../../hooks/use-routing-form';
import type { RoutingTierShare } from '../../lib/routing-traffic';
import { RoutingBoard } from '../routing-board';

/**
 * Whether the traffic query has an answer yet. `actual` alone cannot say: it is `undefined` both
 * while the query is in flight and when a measured window genuinely holds no traffic for this model,
 * and calling the first case "no traffic yet" reports a measurement nobody took — permanently, once
 * the request has failed.
 */
export type RoutingTrafficState = 'pending' | 'unavailable' | 'ready';

export interface RoutingModelTopologyTabProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly actual: readonly RoutingTierShare[] | undefined;
  readonly trafficState: RoutingTrafficState;
}

const trafficNotice = (state: RoutingTrafficState): string | null => {
  if (state === 'pending') return m['dashboard.routing.detail.traffic_pending']();
  if (state === 'unavailable') return m['dashboard.routing.detail.traffic_unavailable']();
  // Measured, and this model served nothing in the window.
  return m['dashboard.routing.detail.no_traffic_yet']();
};

export const RoutingModelTopologyTab: React.FC<RoutingModelTopologyTabProps> = ({
  form,
  model,
  writable,
  actual,
  trafficState,
}) => {
  const notice = actual === undefined ? trafficNotice(trafficState) : null;

  return (
    <div className="space-y-2">
      {notice === null ? null : <p className="text-sm text-muted-foreground">{notice}</p>}
      <RoutingBoard form={form} model={model} writable={writable} actual={actual} />
    </div>
  );
};
