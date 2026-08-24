import type { DashboardRoutingModel } from '@aio-proxy/types';

import type { useRoutingForm } from '../hooks/use-routing-form';
import { RoutingBoardCanvas } from './routing-board-canvas';

interface RoutingBoardProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
}

export const RoutingBoard: React.FC<RoutingBoardProps> = ({ form, model, writable }) => (
  <form.Subscribe selector={(state) => state.values.providers}>
    {(rows) => <RoutingBoardCanvas form={form} model={model} rows={rows} writable={writable} />}
  </form.Subscribe>
);
