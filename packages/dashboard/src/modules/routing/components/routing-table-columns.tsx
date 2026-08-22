import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import type { ColumnDef } from '@tanstack/react-table';

import { tableHead } from '@/components/data-table/table-head';
import type { DataTableFeatures } from '@/hooks/use-data-table';

import { formatRoutingTiers } from '../lib/routing-summary';

export const createRoutingColumns = (
  onEdit: (model: DashboardRoutingModel) => void,
): ColumnDef<DataTableFeatures, DashboardRoutingModel>[] => [
  {
    id: 'modelId',
    enableHiding: false,
    accessorKey: 'modelId',
    meta: { label: () => m['dashboard.routing.table.col_model']() },
    header: tableHead(() => m['dashboard.routing.table.col_model']()),
    cell: ({ row }) => <span className="font-mono text-sm">{row.original.modelId}</span>,
  },
  {
    id: 'route',
    accessorFn: (model) => formatRoutingTiers(model.tiers),
    meta: { label: () => m['dashboard.routing.table.col_route']() },
    header: tableHead(() => m['dashboard.routing.table.col_route']()),
    cell: ({ row }) => {
      const summary = formatRoutingTiers(row.original.tiers);
      if (summary === '') {
        return <Badge variant="outline">{m['dashboard.routing.table.disabled']()}</Badge>;
      }
      return <span className="text-sm">{summary}</span>;
    },
  },
  {
    id: 'providers',
    accessorFn: (model) => `${model.eligibleProviderCount} / ${model.providerCount}`,
    meta: { label: () => m['dashboard.routing.table.col_providers']() },
    header: tableHead(() => m['dashboard.routing.table.col_providers']()),
    cell: ({ row }) => (
      <span>
        {row.original.eligibleProviderCount} / {row.original.providerCount}
      </span>
    ),
  },
  {
    id: 'overrides',
    accessorFn: (model) => String(model.hasOverrides),
    meta: { label: () => m['dashboard.routing.table.col_overrides']() },
    header: tableHead(() => m['dashboard.routing.table.col_overrides']()),
    cell: ({ row }) => (
      <Badge variant={row.original.hasOverrides ? 'secondary' : 'outline'}>
        {row.original.hasOverrides
          ? m['dashboard.routing.table.overrides_yes']()
          : m['dashboard.routing.table.overrides_no']()}
      </Badge>
    ),
  },
  {
    id: 'actions',
    enableHiding: false,
    enableSorting: false,
    header: tableHead(() => m['dashboard.routing.table.col_actions']()),
    cell: ({ row }) => (
      <div className="text-right">
        <Button type="button" size="sm" variant="outline" onClick={() => onEdit(row.original)}>
          {m['dashboard.routing.table.edit']()}
        </Button>
      </div>
    ),
  },
];
