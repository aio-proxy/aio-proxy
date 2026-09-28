import { m } from '@aio-proxy/i18n';
import type React from 'react';

import { PROVIDER_ROUTING_ROW_GRID } from '../../lib/provider-routing-board';

/** Column names at the top of each tier. "Provider" starts under the drag handles, as in a table header. */
export const ProviderRoutingColumns: React.FC = () => (
  // Rows start with a drag handle (size-7 plus gap-2.5) before the columns below line up.
  <div className={`${PROVIDER_ROUTING_ROW_GRID} pl-[2.375rem] text-xs whitespace-nowrap text-muted-foreground`}>
    <span className="-ml-[2.375rem]">{m['dashboard.traces.provider']()}</span>
    <span className="text-center">{m['dashboard.routing.detail.col_weight']()}</span>
    <span className="text-right">{m['dashboard.routing.detail.col_share']()}</span>
  </div>
);
