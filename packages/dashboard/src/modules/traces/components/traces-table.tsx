import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSummary } from '@aio-proxy/types';
import { type CellContext, type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

import { DataTablePagination } from '@/components/data-table-pagination';
import { ProtocolLabel } from '@/components/protocol-label';
import { TokenCount } from '@/components/token-count';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import { formatTraceCost, formatTraceDuration } from '../trace-formatters';
import type { TraceSearch } from '../trace-search';
import { TraceStatus } from './trace-status';

interface TracesTableProps {
  readonly data: {
    readonly items: readonly DashboardTraceSummary[];
    readonly pageCount: number;
  };
  readonly search: TraceSearch;
  readonly onSearchChange: (search: TraceSearch) => void;
  readonly onSelect: (traceId: string) => void;
}

const columns: ColumnDef<DashboardTraceSummary>[] = [
  {
    accessorKey: 'startedAt',
    header: () => m['dashboard.traces.started_at'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => new Date(row.original.startedAt).toLocaleString(),
  },
  {
    id: 'status',
    header: () => m['dashboard.traces.status'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => {
      return <TraceStatus item={row.original} className="min-w-24" />;
    },
  },
  {
    id: 'session',
    header: () => m['dashboard.traces.session'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => {
      const session = row.original.session;
      return session === undefined ? (
        m['dashboard.traces.not_available']()
      ) : (
        <div className="min-w-28">
          <Tooltip>
            <TooltipTrigger
              render={
                <span
                  tabIndex={0}
                  className="block max-w-48 cursor-help truncate underline decoration-dotted underline-offset-4"
                />
              }
            >
              {session.id}
            </TooltipTrigger>
            <TooltipContent>{m['dashboard.traces.session_source_value']({ source: session.source })}</TooltipContent>
          </Tooltip>
        </div>
      );
    },
  },
  {
    accessorKey: 'inboundProtocol',
    header: () => m['dashboard.traces.protocol'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => (
      <ProtocolLabel protocol={row.original.inboundProtocol} />
    ),
  },
  {
    accessorKey: 'requestedModelId',
    header: () => m['dashboard.traces.requested_model'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) =>
      row.original.requestedModelId ?? m['dashboard.traces.not_available'](),
  },
  {
    id: 'finalProvider',
    header: () => m['dashboard.traces.provider'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) =>
      row.original.finalProviderId ?? m['dashboard.traces.not_available'](),
  },
  {
    accessorKey: 'finalHttpStatus',
    header: () => m['dashboard.traces.http_status'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) =>
      row.original.finalHttpStatus ?? m['dashboard.traces.not_available'](),
  },
  {
    accessorKey: 'durationMs',
    header: () => m['dashboard.traces.duration'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => (
      <div className="min-w-24">
        <div>{formatTraceDuration(row.original.durationMs)}</div>
        {row.original.stream === true ? (
          <div className="text-xs text-muted-foreground">
            {m['dashboard.traces.ttft']()}{' '}
            {row.original.ttftMs === undefined
              ? m['dashboard.traces.ttft_unavailable']()
              : formatTraceDuration(row.original.ttftMs)}
          </div>
        ) : null}
      </div>
    ),
  },
  {
    id: 'tokens',
    header: () => m['dashboard.traces.tokens'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => {
      const usage = row.original.usage;
      if (
        usage?.inputTokens === undefined &&
        usage?.outputTokens === undefined &&
        usage?.cacheReadTokens === undefined &&
        usage?.cacheWriteTokens === undefined
      ) {
        return m['dashboard.traces.not_available']();
      }
      return (
        <div className="min-w-32">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-baseline">
              ↑<TokenCount value={usage.inputTokens} />
            </span>
            <span className="inline-flex items-baseline">
              ↓<TokenCount value={usage.outputTokens} />
            </span>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-baseline gap-1">
              {m['dashboard.traces.cache_read_short']()}
              <TokenCount value={usage.cacheReadTokens} />
            </span>
            <span className="inline-flex items-baseline gap-1">
              {m['dashboard.traces.cache_write_short']()}
              <TokenCount value={usage.cacheWriteTokens} />
            </span>
          </div>
        </div>
      );
    },
  },
  {
    id: 'cost',
    header: () => m['dashboard.traces.cost'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) =>
      formatTraceCost(row.original.usage?.estimatedCostUsd),
  },
];

export const TracesTable: React.FC<TracesTableProps> = ({ data, search, onSearchChange, onSelect }) => {
  const table = useReactTable({
    data: [...data.items],
    columns,
    state: { pagination: { pageIndex: search.page - 1, pageSize: search.pageSize } },
    manualPagination: true,
    pageCount: data.pageCount,
    onPaginationChange: (updater) => {
      const current = { pageIndex: search.page - 1, pageSize: search.pageSize };
      const next = typeof updater === 'function' ? updater(current) : updater;
      onSearchChange({
        ...search,
        page: next.pageSize === current.pageSize ? next.pageIndex + 1 : 1,
        pageSize: next.pageSize as TraceSearch['pageSize'],
      });
    },
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
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
              <TableRow
                key={row.id}
                tabIndex={0}
                role="button"
                aria-label={`${m['dashboard.traces.details']()}: ${row.original.traceId}`}
                className="cursor-pointer"
                onClick={() => onSelect(row.original.traceId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelect(row.original.traceId);
                  }
                }}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <DataTablePagination table={table} pageSizeOptions={[10, 20, 50, 100]} />
    </div>
  );
};
