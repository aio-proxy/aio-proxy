import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSpan, DashboardTraceSummary, TraceTerminationReason } from '@aio-proxy/types';
import { type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface TraceSpansTableProps {
  readonly spans: readonly DashboardTraceSpan[];
}

const terminationLabel = (reason: TraceTerminationReason) => m[`dashboard.traces.${reason}`]();

export const renderTraceStatus = (
  item: Pick<DashboardTraceSummary | DashboardTraceSpan, 'endedAt' | 'otelStatusCode' | 'terminationReason'>,
) => (
  <div className="flex flex-wrap justify-end gap-1">
    {item.endedAt === null ? (
      <Badge variant="secondary">{m['dashboard.traces.running']()}</Badge>
    ) : (
      <Badge
        variant={item.otelStatusCode === 'ERROR' ? 'destructive' : item.otelStatusCode === 'OK' ? 'default' : 'outline'}
      >
        {item.otelStatusCode}
      </Badge>
    )}
    {item.terminationReason === undefined ? null : (
      <Badge variant="outline">{terminationLabel(item.terminationReason)}</Badge>
    )}
  </div>
);

const columns: ColumnDef<DashboardTraceSpan>[] = [
  {
    accessorKey: 'name',
    header: () => m['dashboard.traces.span_name'](),
    cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
  },
  { accessorKey: 'kind', header: () => m['dashboard.traces.span_kind']() },
  {
    accessorKey: 'startedAt',
    header: () => m['dashboard.traces.span_start'](),
    cell: ({ row }) => new Date(row.original.startedAt).toLocaleString(),
  },
  {
    accessorKey: 'endedAt',
    header: () => m['dashboard.traces.span_end'](),
    cell: ({ row }) =>
      row.original.endedAt === null
        ? m['dashboard.traces.not_available']()
        : new Date(row.original.endedAt).toLocaleString(),
  },
  {
    id: 'status',
    header: () => m['dashboard.traces.span_status'](),
    cell: ({ row }) => renderTraceStatus(row.original),
  },
  {
    id: 'attributes',
    header: () => m['dashboard.traces.attributes'](),
    cell: ({ row }) => Object.keys(row.original.attributes).length,
  },
  { id: 'events', header: () => m['dashboard.traces.events'](), cell: ({ row }) => row.original.events.length },
  { id: 'links', header: () => m['dashboard.traces.links'](), cell: ({ row }) => row.original.links.length },
];

export const TraceSpansTable: React.FC<TraceSpansTableProps> = ({ spans }) => {
  const table = useReactTable({ data: [...spans], columns, getCoreRowModel: getCoreRowModel() });

  return (
    <div className="overflow-x-auto rounded-2xl border">
      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => (
                <TableHead key={header.id}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-testid="trace-span">
              {row.getVisibleCells().map((cell) => (
                <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
};
