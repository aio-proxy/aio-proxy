import type { DashboardRoutingModel, RouterSelection } from '@aio-proxy/types';

import type { useRoutingForm } from '../hooks/use-routing-form';
import type { RoutingTierShare } from '../lib/routing-traffic';
import { RoutingBoardCanvas } from './routing-board-canvas';

interface RoutingBoardProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly writable: boolean;
  readonly actual?: readonly RoutingTierShare[] | undefined;
  readonly selection?: RouterSelection;
}

export const RoutingBoard: React.FC<RoutingBoardProps> = ({
  form,
  model,
  writable,
  actual,
  selection = 'weighted',
}) => (
  <form.Subscribe selector={(state) => state.values.providers}>
    {(rows) => (
      <RoutingBoardCanvas
        form={form}
        model={model}
        rows={rows}
        writable={writable}
        actual={actual}
        selection={selection}
      />
    )}
  </form.Subscribe>
);
