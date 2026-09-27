import { getLocale, m } from '@aio-proxy/i18n';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef } from '@tanstack/react-table';
import { Fragment, useMemo } from 'react';

import { DataTableControls } from '@/components/data-table/data-table-controls';
import { Pagination } from '@/components/data-table/pagination';
import { tableHead } from '@/components/data-table/table-head';
import { type DataTableFeatures, useDataTable } from '@/hooks/use-data-table';
import { formatDuration } from '@/lib/format-duration';

import { formatRoutingShare } from '../../lib/routing-summary';

export type RoutingTrafficSummaryRow = {
  readonly providerId: string;
  /** `null` when the Provider shows up in the buckets but has no totals row for this window. */
  readonly finalCount: bigint | null;
  readonly attemptCount: bigint | null;
  readonly successRate: number | null;
  readonly p95LatencyMs: number | null;
};

interface RoutingTrafficSummaryTableProps {
  readonly rows: readonly RoutingTrafficSummaryRow[];
}

/** Counts are BigInt because they can pass MAX_SAFE_INTEGER; unknown sorts below every measurement
 * so the two ends of the sort stay predictable instead of interleaving. */
const compareCounts = (left: bigint | null, right: bigint | null): number => {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
};

const compareMetric = (left: number | null, right: number | null): number => {
  if (left === null || right === null) return left === right ? 0 : left === null ? -1 : 1;
  return left - right;
};

/** No measurement for this Provider and column. Not zero, which would claim a real observation. */
const UNKNOWN = '—';

export const RoutingTrafficSummaryTable: React.FC<RoutingTrafficSummaryTableProps> = ({ rows }) => {
  'use no memo';

  const locale = getLocale();
  const columns = useMemo<readonly ColumnDef<DataTableFeatures, RoutingTrafficSummaryRow>[]>(
    () => [
      {
        accessorKey: 'providerId',
        enableHiding: false,
        meta: { label: () => m['dashboard.traces.provider']() },
        header: tableHead(() => m['dashboard.traces.provider']()),
        cell: ({ row }) => <span className="font-mono text-xs">{row.original.providerId}</span>,
      },
      {
        id: 'served',
        // Served is the quantity the chart above plots. Attempts counts every try including the
        // failed ones, so the two columns legitimately disagree and both are shown rather than
        // leaving one number on the chart and a different one in the table.
        accessorFn: (row) => (row.finalCount === null ? '' : String(row.finalCount)),
        sortFn: (left, right) => compareCounts(left.original.finalCount, right.original.finalCount),
        meta: { label: () => m['dashboard.routing.traffic.served']() },
        header: tableHead(() => m['dashboard.routing.traffic.served']()),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.finalCount === null ? UNKNOWN : String(row.original.finalCount)}
          </span>
        ),
      },
      {
        id: 'attempts',
        accessorFn: (row) => (row.attemptCount === null ? '' : String(row.attemptCount)),
        sortFn: (left, right) => compareCounts(left.original.attemptCount, right.original.attemptCount),
        meta: { label: () => m['dashboard.traces.span_metric_attempts']() },
        header: tableHead(() => m['dashboard.traces.span_metric_attempts']()),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.attemptCount === null ? UNKNOWN : String(row.original.attemptCount)}
          </span>
        ),
      },
      {
        id: 'successRate',
        accessorFn: (row) => row.successRate,
        sortFn: (left, right) => compareMetric(left.original.successRate, right.original.successRate),
        meta: { label: () => m['dashboard.overview.success_rate']() },
        header: tableHead(() => m['dashboard.overview.success_rate']()),
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.successRate === null ? UNKNOWN : formatRoutingShare(row.original.successRate)}
          </span>
        ),
      },
      {
        id: 'p95',
        accessorFn: (row) => row.p95LatencyMs,
        sortFn: (left, right) => compareMetric(left.original.p95LatencyMs, right.original.p95LatencyMs),
        meta: { label: () => m['dashboard.overview.p95_latency']() },
        header: tableHead(() => m['dashboard.overview.p95_latency']()),
        // p95 covers failed attempts too, so a Provider that fails fast reads well here next to a
        // poor success rate. `null` means no sample, never zero latency.
        cell: ({ row }) => (
          <span className="tabular-nums">
            {row.original.p95LatencyMs === null ? UNKNOWN : formatDuration(row.original.p95LatencyMs, locale)}
          </span>
        ),
      },
    ],
    [locale],
  );
  const { table } = useDataTable(rows, columns, { getRowId: (row) => row.providerId });

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <DataTableControls
        table={table}
        filterLabel={m['dashboard.routing.traffic.filter']()}
        filterPlaceholder={m['dashboard.routing.traffic.filter_placeholder']()}
        columnsLabel={m['dashboard.routing.table.columns']()}
      />
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <Fragment key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </Fragment>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-testid={`routing-traffic-row-${row.original.providerId}`}>
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {table.getPageCount() > 1 ? (
        <Pagination
          pageSize={table.state.pagination.pageSize}
          canPrevious={table.getCanPreviousPage()}
          canNext={table.getCanNextPage()}
          onShowSizeChange={table.setPageSize}
          onPrevious={table.previousPage}
          onNext={table.nextPage}
        />
      ) : null}
    </div>
  );
};
