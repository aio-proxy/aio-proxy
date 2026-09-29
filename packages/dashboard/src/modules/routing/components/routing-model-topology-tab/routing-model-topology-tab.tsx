import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { useRoutingForm } from '../../hooks/use-routing-form';
import type { RoutingTierShare } from '../../lib/routing-traffic';
import { RoutingBoard } from '../routing-board';

export interface RoutingModelTopologyTabProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  /**
   * Measured shares, `undefined` while traffic is loading, has failed, or holds nothing for this
   * model. The rows then read "—" rather than 0%, and the Traffic card says which of the three it is.
   */
  readonly actual: readonly RoutingTierShare[] | undefined;
}

export const RoutingModelTopologyTab: React.FC<RoutingModelTopologyTabProps> = ({ form, model, writable, actual }) => (
  <RoutingBoard form={form} model={model} writable={writable} actual={actual} />
);
