import { getLocale, m } from '@aio-proxy/i18n';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef } from '@tanstack/react-table';
import { flexRender } from '@tanstack/react-table';
import { Fragment, useMemo } from 'react';

import { DataTableHeaderCell } from '@/components/data-table-header-cell';
import { DataTablePagination } from '@/components/data-table-pagination';
import { useDataTable } from '@/hooks/use-data-table';

import type { OverviewData } from '../../services/overview-service';

interface ProviderHealthTableProps {
  readonly rows: OverviewData['providerHealth'];
}

type ProviderHealthRow = OverviewData['providerHealth'][number];

const withSortingHandler = (handler: ((event: unknown) => void) | undefined) =>
  handler === undefined ? {} : { onToggleSorting: handler };

export const ProviderHealthTable: React.FC<ProviderHealthTableProps> = ({ rows }) => {
  'use no memo';

  const locale = getLocale();
  const columns = useMemo<readonly ColumnDef<ProviderHealthRow>[]>(() => {
    const percentFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });

    return [
      {
        accessorKey: 'providerId',
        header: ({ column }) => (
          <DataTableHeaderCell
            label={m['dashboard.overview.provider_id']()}
            canSort={column.getCanSort()}
            sortDirection={column.getIsSorted()}
            {...withSortingHandler(column.getToggleSortingHandler())}
          />
        ),
        cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span>,
      },
      {
        accessorKey: 'successRate',
        header: ({ column }) => (
          <DataTableHeaderCell
            label={m['dashboard.overview.success_rate']()}
            canSort={column.getCanSort()}
            sortDirection={column.getIsSorted()}
            {...withSortingHandler(column.getToggleSortingHandler())}
          />
        ),
        cell: ({ getValue }) => <span className="tabular-nums">{percentFormatter.format(Number(getValue()))}</span>,
      },
      {
        accessorKey: 'p95LatencyMs',
        header: ({ column }) => (
          <DataTableHeaderCell
            label={m['dashboard.overview.p95_latency']()}
            canSort={column.getCanSort()}
            sortDirection={column.getIsSorted()}
            {...withSortingHandler(column.getToggleSortingHandler())}
          />
        ),
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
                    {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  </Fragment>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="h-24 text-center text-muted-foreground">
                  {m['dashboard.overview.no_provider_activity']()}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
        {table.getPageCount() > 1 ? <DataTablePagination table={table} /> : null}
      </CardContent>
    </Card>
  );
};
