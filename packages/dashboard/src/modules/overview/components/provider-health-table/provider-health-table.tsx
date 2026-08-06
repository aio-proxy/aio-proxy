import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { Card, CardContent, CardHeader, CardTitle } from '@aio-proxy/ui/components/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef, HeaderContext } from '@tanstack/react-table';
import { flexRender } from '@tanstack/react-table';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { Fragment, useMemo } from 'react';

import { PaginationControls } from '@/components/pagination-controls';
import { useDataTable } from '@/hooks/use-data-table';

import type { OverviewDiagnosticsData } from '../../services/overview-service';

interface ProviderHealthTableProps {
  readonly rows: OverviewDiagnosticsData['providerHealth'];
}

type ProviderHealthRow = OverviewDiagnosticsData['providerHealth'][number];

const sortableHeader =
  (label: () => string) =>
  ({ column }: HeaderContext<ProviderHealthRow, unknown>) => {
    const canSort = column.getCanSort();
    const sortDirection = column.getIsSorted();
    return (
      <TableHead
        aria-sort={
          canSort
            ? sortDirection === 'asc'
              ? 'ascending'
              : sortDirection === 'desc'
                ? 'descending'
                : 'none'
            : undefined
        }
      >
        {canSort ? (
          <Button variant="ghost" size="sm" onClick={column.getToggleSortingHandler()}>
            {label()}
            {sortDirection === 'asc' ? <ArrowUp /> : sortDirection === 'desc' ? <ArrowDown /> : null}
          </Button>
        ) : (
          label()
        )}
      </TableHead>
    );
  };

export const ProviderHealthTable: React.FC<ProviderHealthTableProps> = ({ rows }) => {
  'use no memo';

  const locale = getLocale();
  const columns = useMemo<readonly ColumnDef<ProviderHealthRow>[]>(() => {
    const percentFormatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: 'percent' });
    return [
      {
        accessorKey: 'providerId',
        header: sortableHeader(() => m['dashboard.overview.provider_id']()),
        cell: ({ getValue }) => <span className="font-mono text-xs">{String(getValue())}</span>,
      },
      {
        accessorKey: 'successRate',
        header: sortableHeader(() => m['dashboard.overview.success_rate']()),
        cell: ({ getValue }) => <span className="tabular-nums">{percentFormatter.format(Number(getValue()))}</span>,
      },
      {
        accessorKey: 'p95LatencyMs',
        header: sortableHeader(() => m['dashboard.overview.p95_latency']()),
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
                <TableCell
                  colSpan={table.getVisibleLeafColumns().length}
                  className="h-24 text-center text-muted-foreground"
                >
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
        {table.getPageCount() > 1 ? (
          <PaginationControls
            pageSize={table.getState().pagination.pageSize}
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
