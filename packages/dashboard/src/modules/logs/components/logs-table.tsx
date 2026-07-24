import type { DashboardRequestLog, DashboardRequestLogsResponse, RequestOutcome } from "@aio-proxy/types";

import { m } from "@aio-proxy/i18n";
import { type CellContext, type ColumnDef, flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { ArrowRight } from "lucide-react";

import { DataTablePagination } from "@/components/data-table-pagination";
import { ProtocolLabel } from "@/components/protocol-label";
import { TokenCount } from "@/components/token-count";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import type { LogsSearch } from "../logs-search";

import { displayTotalTokens, formatDuration, formatLogCost } from "../log-formatters";

interface LogsTableProps {
  readonly data: DashboardRequestLogsResponse;
  readonly search: LogsSearch;
  readonly onSearchChange: (search: LogsSearch) => void;
  readonly onSelect: (log: DashboardRequestLog) => void;
}

const outcomeLabel = (outcome: RequestOutcome) => m[`dashboard.logs.${outcome}`]();
const outcomeBadgeVariants = {
  success: "default",
  failure: "destructive",
  cancelled: "secondary",
} as const satisfies Record<RequestOutcome, "default" | "destructive" | "secondary">;
const columns: ColumnDef<DashboardRequestLog>[] = [
  {
    accessorKey: "completedAt",
    header: () => m["dashboard.logs.completed_at"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => new Date(row.original.completedAt).toLocaleString(),
  },
  {
    accessorKey: "outcome",
    header: () => m["dashboard.logs.outcome"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => (
      <Badge variant={outcomeBadgeVariants[row.original.outcome]}>{outcomeLabel(row.original.outcome)}</Badge>
    ),
  },
  {
    accessorKey: "inboundProtocol",
    header: () => m["dashboard.logs.protocol"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => (
      <ProtocolLabel protocol={row.original.inboundProtocol} />
    ),
  },
  {
    accessorKey: "finalProviderId",
    header: () => m["dashboard.logs.final_provider"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) =>
      row.original.finalProviderName ?? row.original.finalProviderId ?? m["dashboard.logs.not_available"](),
  },
  {
    id: "model",
    header: () => m["dashboard.logs.model"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => {
      const log = row.original;
      const requestedModel =
        log.requestedModelDisplayName ??
        (log.finalModelId === log.requestedModelId ? log.finalModelDisplayName : undefined) ??
        log.requestedModelId;
      const finalModel = log.finalModelDisplayName ?? log.finalModelId;
      return (
        <div className="min-w-32">
          <div>{requestedModel}</div>
          {log.finalModelId !== undefined && log.finalModelId !== log.requestedModelId ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowRight className="size-3" aria-hidden="true" />
              <span>{finalModel}</span>
            </div>
          ) : null}
        </div>
      );
    },
  },
  {
    accessorKey: "finalStatusCode",
    header: () => m["dashboard.logs.status"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) =>
      row.original.finalStatusCode ?? m["dashboard.logs.not_available"](),
  },
  {
    accessorKey: "durationMs",
    header: () => m["dashboard.logs.duration"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => formatDuration(row.original.durationMs),
  },
  {
    id: "tokens",
    header: () => m["dashboard.logs.tokens"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => {
      const tokens = displayTotalTokens(row.original.usage);
      return tokens === undefined ? m["dashboard.logs.not_available"]() : <TokenCount value={tokens} />;
    },
  },
  {
    id: "cost",
    header: () => m["dashboard.logs.cost"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => formatLogCost(row.original.usage?.estimatedCostUsd),
  },
];

export const LogsTable: React.FC<LogsTableProps> = ({ data, search, onSearchChange, onSelect }) => {
  const table = useReactTable({
    data: data.items as DashboardRequestLog[],
    columns,
    state: { pagination: { pageIndex: search.page - 1, pageSize: search.pageSize } },
    manualPagination: true,
    pageCount: data.pageCount,
    onPaginationChange: (updater) => {
      const current = { pageIndex: search.page - 1, pageSize: search.pageSize };
      const next = typeof updater === "function" ? updater(current) : updater;
      onSearchChange({
        ...search,
        page: next.pageSize === current.pageSize ? next.pageIndex + 1 : 1,
        pageSize: next.pageSize as LogsSearch["pageSize"],
      });
    },
    getCoreRowModel: getCoreRowModel(),
  });
  return (
    <div className="space-y-3">
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
              <TableRow
                key={row.id}
                tabIndex={0}
                role="button"
                aria-label={`${m["dashboard.logs.details"]()}: ${row.original.requestId}`}
                className="cursor-pointer"
                onClick={() => onSelect(row.original)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(row.original);
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
