import { m } from '@aio-proxy/i18n';
import {
  type DashboardPluginSummary,
  type DashboardProviderSummary,
  type DashboardTraceSummary,
  ProviderKind,
} from '@aio-proxy/types';
import { ScrollArea, ScrollBar } from '@aio-proxy/ui/components/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { type ColumnDef, tableFeatures, useTable } from '@tanstack/react-table';
import { useMemo } from 'react';

import { Pagination } from '@/components/data-table/pagination';
import { ProviderIdLabel } from '@/components/provider-id-label';
import { resolveDashboardText } from '@/lib/localized-text';

import { useProviderCatalog } from '../../hooks/use-provider-catalog';
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

const tracesTableFeatures = tableFeatures({});

type TraceColumn = ColumnDef<typeof tracesTableFeatures, DashboardTraceSummary>;

const oauthServiceLabel = (
  provider: DashboardProviderSummary | undefined,
  plugins: readonly DashboardPluginSummary[] | undefined,
): string | undefined => {
  if (provider?.kind !== ProviderKind.OAuth || provider.plugin === undefined) return undefined;
  const plugin = plugins?.find((item) => item.packageName === provider.plugin);
  const service =
    plugin?.displayName === undefined
      ? provider.plugin.slice(provider.plugin.lastIndexOf('/') + 1)
      : resolveDashboardText(plugin.displayName);
  return provider.capability === undefined || provider.capability === 'default'
    ? service
    : `${service} / ${provider.capability}`;
};

const traceColumns = (
  providers: readonly DashboardProviderSummary[] | undefined,
  plugins: readonly DashboardPluginSummary[] | undefined,
): TraceColumn[] => [
  {
    accessorKey: 'startedAt',
    header: () => m['dashboard.traces.started_at'](),
    cell: ({ row }) => (
      <time dateTime={row.original.startedAt}>{new Date(row.original.startedAt).toLocaleString()}</time>
    ),
  },
  {
    accessorKey: 'traceId',
    header: () => m['dashboard.traces.trace_id'](),
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.traceId}</span>,
  },
  {
    accessorKey: 'inboundProtocol',
    header: () => m['dashboard.traces.protocol'](),
    cell: ({ row }) => row.original.inboundProtocol,
  },
  {
    accessorKey: 'requestedModelId',
    header: () => m['dashboard.traces.model'](),
    cell: ({ row }) => {
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
    header: () => m['dashboard.traces.provider'](),
    cell: ({ row }) => {
      const providerId = row.original.finalProviderId;
      if (providerId === undefined) return TRACE_PLACEHOLDER;
      const provider = providers?.find((item) => item.id === providerId);
      const service = oauthServiceLabel(provider, plugins);
      const accountLabel = provider?.accountLabel;
      const label =
        accountLabel === undefined ? (
          <ProviderIdLabel providerId={providerId} providers={providers} mark={false} className="max-w-48" />
        ) : (
          <span className="inline-block max-w-48 min-w-0 truncate" title={providerId}>
            {accountLabel}
          </span>
        );
      if (service === undefined || accountLabel === undefined || service === accountLabel) return label;
      return (
        <span className="inline-flex max-w-48 min-w-0 flex-col leading-tight">
          <span className="truncate" title={service}>
            {service}
          </span>
          <span className="text-xs text-muted-foreground">{label}</span>
        </span>
      );
    },
  },
  {
    accessorKey: 'finalHttpStatus',
    header: () => m['dashboard.traces.http_status'](),
    cell: ({ row }) => row.original.finalHttpStatus ?? TRACE_PLACEHOLDER,
  },
  {
    id: 'requestStatus',
    header: () => m['dashboard.traces.status'](),
    cell: ({ row }) => <TraceStatus item={row.original} />,
  },
  {
    id: 'latency',
    header: () => m['dashboard.traces.latency'](),
    cell: ({ row }) => (
      <TraceLatencyCell
        durationMs={row.original.durationMs}
        stream={row.original.stream}
        ttftMs={row.original.ttftMs}
        fast={row.original.fast}
        outputTokens={row.original.usage?.outputTokens}
      />
    ),
  },
  {
    id: 'tokens',
    header: () => m['dashboard.traces.tokens'](),
    cell: ({ row }) => <TraceTokenCell usage={row.original.usage} />,
  },
  {
    id: 'cost',
    header: () => m['dashboard.traces.cost'](),
    cell: ({ row }) => formatTraceCost(row.original.usage?.estimatedCostUsd),
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
  const catalog = useProviderCatalog();
  const columns = useMemo(() => traceColumns(catalog.providers, catalog.plugins), [catalog.providers, catalog.plugins]);
  const tableData = useMemo(() => [...data.items], [data.items]);
  const table = useTable({
    features: tracesTableFeatures,
    data: tableData,
    columns,
    getRowId: (row) => row.traceId,
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ScrollArea className="min-h-0 min-w-0 flex-1 **:data-[slot=table-container]:overflow-visible">
        <div data-slot="traces-table-scroll-content" className="px-3 sm:px-4">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((group) => (
                <TableRow key={group.id}>
                  {group.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : <table.FlexRender header={header} />}
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
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id}>
                      <table.FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <ScrollBar
          className="opacity-0 transition-opacity data-hovering:opacity-100 data-scrolling:opacity-100"
          orientation="horizontal"
        />
      </ScrollArea>
      <div data-slot="traces-table-pagination" className="shrink-0 border-t px-3 pt-3 sm:px-4">
        <Pagination
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
