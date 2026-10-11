import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel, RouterSelection } from '@aio-proxy/types';
import type { ColumnDef } from '@tanstack/react-table';

import { tableHead } from '@/components/data-table/table-head';
import type { DataTableFeatures } from '@/hooks/use-data-table';

import { type RoutingTrafficIndex, modelTrafficSummary } from '../lib/routing-traffic';
import { RoutingModelCell } from './routing-model-cell';
import { RoutingRoute } from './routing-route';

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

interface CreateRoutingColumnsOptions {
  readonly traffic: RoutingTrafficIndex | undefined;
  readonly selection?: RouterSelection;
}

export const createRoutingColumns = ({
  traffic,
  selection,
}: CreateRoutingColumnsOptions): ColumnDef<DataTableFeatures, DashboardRoutingModel>[] => [
  {
    id: 'modelId',
    enableHiding: false,
    accessorKey: 'modelId',
    // Fixed so the route column starts at the same x on every page, whatever the longest ID there is.
    meta: { className: 'w-64' },
    header: tableHead(() => m['dashboard.routing.table.col_model']()),
    cell: ({ row }) => (
      <RoutingModelCell model={row.original} totals={traffic?.get(row.original.modelId)} selection={selection} />
    ),
  },
  {
    id: 'route',
    accessorFn: (model) => model.tiers.length,
    header: tableHead(() => m['dashboard.routing.table.col_route']()),
    cell: ({ row }) => (
      <RoutingRoute model={row.original} totals={traffic?.get(row.original.modelId)} selection={selection} />
    ),
  },
  {
    id: 'traffic',
    accessorFn: (model) => {
      const summary = modelTrafficSummary(traffic?.get(model.modelId));
      return summary === undefined ? '' : String(summary.finalCount);
    },
    // The accessor is a decimal string, so the automatic comparator orders it as text: "10" sorts
    // before "9", and once counts pass MAX_SAFE_INTEGER no numeric coercion could separate
    // neighbours either — which is why these counts are decoded as BigInt in the first place.
    // Compare the BigInt totals. An unmeasured model sorts below every measured one, so the two
    // ends of the sort stay predictable instead of interleaving "no traffic" with real counts.
    sortFn: (rowA, rowB) => {
      const left = modelTrafficSummary(traffic?.get(rowA.original.modelId))?.finalCount;
      const right = modelTrafficSummary(traffic?.get(rowB.original.modelId))?.finalCount;
      if (left === undefined || right === undefined) {
        return left === right ? 0 : left === undefined ? -1 : 1;
      }
      return left === right ? 0 : left < right ? -1 : 1;
    },
    meta: { className: 'w-32' },
    header: tableHead(() => m['dashboard.routing.table.col_traffic']()),
    cell: ({ row }) => {
      // No index at all means the query is in flight or failed with nothing cached — traffic is
      // unknown, which is not the same as measured and empty. Withhold a value rather than claim
      // the model served nothing, the way the health strip and the deviation filter already do.
      if (traffic === undefined) {
        return <span className="text-sm text-muted-foreground">—</span>;
      }
      const summary = modelTrafficSummary(traffic.get(row.original.modelId));
      if (summary === undefined) {
        return <span className="text-sm text-muted-foreground">{m['dashboard.routing.traffic.none']()}</span>;
      }
      const successLabel =
        summary.successRate === null
          ? null
          : m['dashboard.routing.traffic.success_rate']({ value: percentFormatter.format(summary.successRate) });
      return (
        <div className="flex flex-col gap-0.5 text-sm tabular-nums">
          <span>{numberFormatter.format(summary.finalCount)}</span>
          {successLabel === null ? null : <span className="text-xs text-muted-foreground">{successLabel}</span>}
        </div>
      );
    },
  },
];
