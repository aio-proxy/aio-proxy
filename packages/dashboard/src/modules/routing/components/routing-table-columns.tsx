import { m } from '@aio-proxy/i18n';
import type { DashboardRoutingModel } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import type { ColumnDef } from '@tanstack/react-table';

import { tableHead } from '@/components/data-table/table-head';
import { ProviderIdLabel } from '@/components/provider-id-label';
import type { DataTableFeatures } from '@/hooks/use-data-table';

import { modelRisks } from '../lib/routing-risk';
import { UNKNOWN_LAB, labOf } from '../lib/routing-rows';
import type { RoutingRiskFilter } from '../lib/routing-search';
import { type RoutingTrafficIndex, modelTrafficSummary, tierActualShares } from '../lib/routing-traffic';
import { RoutingShareBar } from './routing-share-bar/routing-share-bar';

const numberFormatter = new Intl.NumberFormat();
const percentFormatter = new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 });

const labLabel = (model: DashboardRoutingModel): string => {
  const lab = labOf(model);
  return lab === UNKNOWN_LAB ? m['dashboard.routing.lab.unknown']() : lab;
};

const riskLabel = (risk: RoutingRiskFilter): string => {
  switch (risk) {
    case 'no-eligible':
      return m['dashboard.routing.risk.no_eligible']();
    case 'single-point':
      return m['dashboard.routing.risk.single_point']();
    case 'deviating':
      return m['dashboard.routing.risk.deviating']();
  }
};

interface CreateRoutingColumnsOptions {
  readonly onEdit: (model: DashboardRoutingModel) => void;
  readonly traffic: RoutingTrafficIndex | undefined;
}

export const createRoutingColumns = ({
  onEdit,
  traffic,
}: CreateRoutingColumnsOptions): ColumnDef<DataTableFeatures, DashboardRoutingModel>[] => [
  {
    id: 'modelId',
    enableHiding: false,
    accessorKey: 'modelId',
    meta: { label: () => m['dashboard.routing.table.col_model']() },
    header: tableHead(() => m['dashboard.routing.table.col_model']()),
    cell: ({ row }) => {
      const model = row.original;
      const risks = modelRisks(model, traffic?.get(model.modelId));
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-sm">{model.modelId}</span>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span>{labLabel(model)}</span>
            {model.catalog?.releaseDate !== undefined ? <span>{model.catalog.releaseDate}</span> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {risks.map((risk) => (
              <Badge key={risk} variant="outline" className="text-xs">
                {riskLabel(risk)}
              </Badge>
            ))}
            {model.hasOverrides ? (
              <Badge variant="secondary" className="text-xs">
                {m['dashboard.routing.table.overrides_yes']()}
              </Badge>
            ) : null}
          </div>
        </div>
      );
    },
  },
  {
    id: 'route',
    accessorFn: (model) => model.tiers.length,
    meta: { label: () => m['dashboard.routing.table.col_route']() },
    header: tableHead(() => m['dashboard.routing.table.col_route']()),
    cell: ({ row }) => {
      const model = row.original;
      const totals = traffic?.get(model.modelId);
      const actual =
        totals === undefined ? undefined : model.tiers.flatMap((tier) => [...tierActualShares(tier, totals)]);
      return <RoutingShareBar tiers={model.tiers} actual={actual} />;
    },
  },
  {
    id: 'providers',
    accessorFn: (model) => `${model.eligibleProviderCount} / ${model.providerCount}`,
    meta: { label: () => m['dashboard.routing.table.col_providers']() },
    header: tableHead(() => m['dashboard.routing.table.col_providers']()),
    cell: ({ row }) => {
      const model = row.original;
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm tabular-nums">
            {model.eligibleProviderCount} / {model.providerCount}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            {model.providers.map((entry) => (
              <ProviderIdLabel key={entry.id} providerId={entry.id} mark={false} className="text-xs" />
            ))}
          </div>
        </div>
      );
    },
  },
  {
    id: 'traffic',
    accessorFn: (model) => {
      const summary = modelTrafficSummary(traffic?.get(model.modelId));
      return summary === undefined ? '' : String(summary.finalCount);
    },
    meta: { label: () => m['dashboard.routing.table.col_traffic']() },
    header: tableHead(() => m['dashboard.routing.table.col_traffic']()),
    cell: ({ row }) => {
      const summary = modelTrafficSummary(traffic?.get(row.original.modelId));
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
