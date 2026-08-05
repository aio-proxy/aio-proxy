import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSummary } from '@aio-proxy/types';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { type CellContext, type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';

import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';
import { formatTraceCost } from '../../lib/trace-formatters';
import type { TraceSearch } from '../../lib/trace-search';
import { TraceLatencyCell } from '../trace-latency-cell';
import { TraceLoadOlderRow } from '../trace-load-older-row';
import { TraceNewItemsRow } from '../trace-new-items-row';
import { TraceStatus } from '../trace-status';
import { TraceTokenCell } from '../trace-token-cell';

interface TracesTableProps {
  readonly data: {
    readonly items: readonly DashboardTraceSummary[];
    readonly pageCount: number;
  };
  readonly search: TraceSearch;
  readonly isFetching: boolean;
  readonly isPlaceholderData: boolean;
  readonly newItemsCount: number;
  readonly onAcceptNewItems: () => void;
  readonly onLoadOlder: () => void;
  readonly onSelect: (traceId: string) => void;
}

const columns: ColumnDef<DashboardTraceSummary>[] = [
  {
    accessorKey: 'startedAt',
    header: () => m['dashboard.traces.started_at'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => (
      <time dateTime={row.original.startedAt}>{new Date(row.original.startedAt).toLocaleString()}</time>
    ),
  },
  {
    accessorKey: 'traceId',
    header: () => m['dashboard.traces.trace_id'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => (
      <span className="font-mono text-xs">{row.original.traceId}</span>
    ),
  },
  {
    id: 'requestStatus',
    header: () => m['dashboard.traces.request_status'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => <TraceStatus item={row.original} />,
  },
  {
    accessorKey: 'inboundProtocol',
    header: () => m['dashboard.traces.protocol'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => row.original.inboundProtocol,
  },
  {
    accessorKey: 'requestedModelId',
    header: () => m['dashboard.traces.requested_model'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => {
      const { requestedModelId, finalModelId } = row.original;
      const primaryModel = requestedModelId ?? finalModelId;
      if (primaryModel === undefined) return TRACE_PLACEHOLDER;
      return (
        <>
          <div>{primaryModel}</div>
          {finalModelId !== undefined && finalModelId !== primaryModel ? (
            <div className="text-xs text-muted-foreground">{finalModelId}</div>
          ) : null}
        </>
      );
    },
  },
  {
    accessorKey: 'finalProviderId',
    header: () => m['dashboard.traces.final_provider'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => row.original.finalProviderId ?? TRACE_PLACEHOLDER,
  },
  {
    accessorKey: 'finalHttpStatus',
    header: () => m['dashboard.traces.final_http_status'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => row.original.finalHttpStatus ?? TRACE_PLACEHOLDER,
  },
  {
    id: 'latency',
    header: () => m['dashboard.traces.latency'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => (
      <TraceLatencyCell
        durationMs={row.original.durationMs}
        stream={row.original.stream}
        ttftMs={row.original.ttftMs}
      />
    ),
  },
  {
    id: 'tokens',
    header: () => m['dashboard.traces.tokens'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) => <TraceTokenCell usage={row.original.usage} />,
  },
  {
    id: 'cost',
    header: () => m['dashboard.traces.cost'](),
    cell: ({ row }: CellContext<DashboardTraceSummary, unknown>) =>
      formatTraceCost(row.original.usage?.estimatedCostUsd),
  },
];

export const TracesTable: React.FC<TracesTableProps> = ({
  data,
  search,
  isFetching,
  isPlaceholderData,
  newItemsCount,
  onAcceptNewItems,
  onLoadOlder,
  onSelect,
}) => {
  const table = useReactTable({
    data: [...data.items],
    columns,
    state: { pagination: { pageIndex: search.page - 1, pageSize: search.pageSize } },
    manualPagination: true,
    pageCount: data.pageCount,
    getRowId: (row) => row.traceId,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
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
        {newItemsCount > 0 ? (
          <TraceNewItemsRow columnCount={columns.length} count={newItemsCount} onAccept={onAcceptNewItems} />
        ) : null}
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
        <TraceLoadOlderRow
          columnCount={columns.length}
          page={search.page}
          pageCount={data.pageCount}
          isFetching={isFetching}
          isPlaceholderData={isPlaceholderData}
          onLoadOlder={onLoadOlder}
        />
      </TableBody>
    </Table>
  );
};
