import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef } from '@tanstack/react-table';
import { Fragment, useMemo } from 'react';

import { DataTableControls } from '@/components/data-table/data-table-controls';
import { Pagination } from '@/components/data-table/pagination';
import { tableHead } from '@/components/data-table/table-head';
import { type DataTableFeatures, useDataTable } from '@/hooks/use-data-table';
import { formatDuration } from '@/lib/format-duration';

import type { OverviewDiagnosticsData } from '../../services/overview-service';

interface ProviderHealthTableProps {
  readonly rows: OverviewDiagnosticsData['providerHealth'];
}

type ProviderHealthRow = NonNullable<OverviewDiagnosticsData['providerHealth']>[number];

export const ProviderHealthTable: React.FC<ProviderHealthTableProps> = ({ rows }) => {
  'use no memo';

  const locale = getLocale();
  const columns = useMemo<readonly ColumnDef<DataTableFeatures, ProviderHealthRow>[]>(() => {
    const percentFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });
    return [
      {
        accessorKey: 'providerId',
        enableHiding: false,
        meta: { label: () => m['dashboard.overview.provider_id']() },
        header: tableHead(() => m['dashboard.overview.provider_id']()),
        cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span>,
      },
      {
        accessorKey: 'successRate',
        meta: { label: () => m['dashboard.overview.success_rate']() },
        header: tableHead(() => m['dashboard.overview.success_rate']()),
        cell: ({ getValue }) => <span className="tabular-nums">{percentFormatter.format(Number(getValue()))}</span>,
      },
      {
        accessorKey: 'p95LatencyMs',
        meta: { label: () => m['dashboard.overview.p95_latency']() },
        header: tableHead(() => m['dashboard.overview.p95_latency']()),
        cell: ({ getValue }) => <span className="tabular-nums">{formatDuration(Number(getValue()), locale)}</span>,
      },
    ];
  }, [locale]);
  const { table } = useDataTable(rows ?? [], columns);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.provider_health_title']()}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-3">
        <DataTableControls
          table={table}
          filterLabel={m['dashboard.providers.table.filter']()}
          filterPlaceholder={m['dashboard.providers.table.filter_placeholder']()}
          columnsLabel={m['dashboard.providers.table.columns']()}
        />
        <Table aria-label={m['dashboard.overview.provider_health_title']()}>
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
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell
                  colSpan={table.getAllLeafColumns().length}
                  className="h-24 text-center text-muted-foreground"
                >
                  {rows === null
                    ? m['dashboard.overview.provider_health_unavailable']()
                    : m['dashboard.overview.no_provider_activity']()}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
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
      </CardContent>
    </Card>
  );
};
