import { m } from '@aio-proxy/i18n';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';

import { ROUTING_BOARD_ROW_GRID } from '../lib/routing-board';

interface RoutingBoardColumnsProps {
  /** Writable rows start with a drag handle (size-7 plus gap-2.5) before the columns below line up. */
  readonly writable: boolean;
}

/** Column names at the top of each tier. "Provider" starts under the drag handles, as in a table header. */
export const RoutingBoardColumns: React.FC<RoutingBoardColumnsProps> = ({ writable }) => (
  <div
    className={cn(
      ROUTING_BOARD_ROW_GRID,
      'text-xs whitespace-nowrap text-muted-foreground',
      writable && 'pl-[2.375rem]',
    )}
  >
    <span className={cn(writable && '-ml-[2.375rem]')}>{m['dashboard.traces.provider']()}</span>
    <span className="text-center">{m['dashboard.routing.detail.col_weight']()}</span>
    <span className="text-right">{m['dashboard.routing.detail.col_share']()}</span>
    <span className="text-right">{m['dashboard.routing.detail.col_actual']()}</span>
    <span className="text-right">{m['dashboard.overview.success_rate']()}</span>
    <span className="text-right">P95</span>
    <span />
  </div>
);
