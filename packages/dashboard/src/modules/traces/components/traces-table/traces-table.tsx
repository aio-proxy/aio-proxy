import { m } from '@aio-proxy/i18n';
import type { DashboardTraceSummary } from '@aio-proxy/types';
import { ScrollArea, ScrollBar } from '@aio-proxy/ui/components/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { type CellContext, type ColumnDef, flexRender, getCoreRowModel, useReactTable } from '@tanstack/react-table';
import { useMemo } from 'react';

import { PaginationControls } from '@/components/pagination-controls';

import { TRACE_PLACEHOLDER } from '../../lib/trace-display-constants';
import { formatTraceCost } from '../../lib/trace-formatters';
import { TraceLatencyCell } from '../trace-latency-cell';
import { TraceNewItemsRow } from '../trace-new-items-row';
import { TraceStatus } from '../trace-status';
import { TraceTokenCell } from '../trace-token-cell';

interface TracesTableProps {
  readonly data: {
    readonly items: readonly DashboardTraceSummary[];
    readonly nextPageToken?: string | undefined;
    readonly prevPageToken?: string | undefined;
  };
  readonly isFetching: boolean;
  readonly pageSize: number;
  readonly newItemsCount: number;
  readonly onAcceptNewItems: () => void;
  readonly onShowSizeChange: (pageSize: number) => void;
  readonly onPrevious: (pageToken: string) => void;
  readonly onNext: (pageToken: string) => void;
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
  isFetching,
  pageSize,
  newItemsCount,
  onAcceptNewItems,
  onShowSizeChange,
  onPrevious,
  onNext,
  onSelect,
}) => {
  const tableData = useMemo(() => [...data.items], [data.items]);
  const table = useReactTable({
    data: tableData,
    columns,
    getRowId: (row) => row.traceId,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 flex-1 **:data-[slot=table-container]:overflow-visible">
        <div data-slot="traces-table-scroll-content" className="px-3 sm:px-4">
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
            </TableBody>
          </Table>
        </div>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <div data-slot="traces-table-pagination" className="shrink-0 border-t px-3 pt-3 sm:px-4">
        <PaginationControls
          pageSize={pageSize}
          pageSizeOptions={[10, 20, 50, 100]}
          canPrevious={!isFetching && data.prevPageToken !== undefined}
          canNext={!isFetching && data.nextPageToken !== undefined}
          onShowSizeChange={onShowSizeChange}
          onPrevious={() => data.prevPageToken !== undefined && onPrevious(data.prevPageToken)}
          onNext={() => data.nextPageToken !== undefined && onNext(data.nextPageToken)}
        />
      </div>
    </div>
  );
};
