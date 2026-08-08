import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef } from '@tanstack/react-table';
import { Fragment, useMemo } from 'react';

import { Pagination } from '@/components/data-table/pagination';
import { tableHead } from '@/components/data-table/table-head';
import { type DataTableFeatures, useDataTable } from '@/hooks/use-data-table';

import type { OverviewDiagnosticsData } from '../../services/overview-service';

interface ProviderHealthTableProps {
  readonly rows: OverviewDiagnosticsData['providerHealth'];
}

type ProviderHealthRow = OverviewDiagnosticsData['providerHealth'][number];

export const ProviderHealthTable: React.FC<ProviderHealthTableProps> = ({ rows }) => {
  'use no memo';

  const locale = getLocale();
  const columns = useMemo<readonly ColumnDef<DataTableFeatures, ProviderHealthRow>[]>(() => {
    const percentFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });
    return [
      {
        accessorKey: 'providerId',
        header: tableHead(() => m['dashboard.overview.provider_id']()),
        cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span>,
      },
      {
        accessorKey: 'successRate',
        header: tableHead(() => m['dashboard.overview.success_rate']()),
        cell: ({ getValue }) => <span className="tabular-nums">{percentFormatter.format(Number(getValue()))}</span>,
      },
      {
        accessorKey: 'p95LatencyMs',
        header: tableHead(() => m['dashboard.overview.p95_latency']()),
        cell: ({ getValue }) => (
          <span className="tabular-nums">{m['dashboard.traces.duration_ms']({ value: Number(getValue()) })}</span>
        ),
      },
    ];
  }, [locale]);
  const { table } = useDataTable(rows, columns);

  return (
    <Card>
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          {m['dashboard.overview.provider_health_title']()}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col gap-3">
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
                  {m['dashboard.overview.no_provider_activity']()}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getAllCells().map((cell) => (
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
