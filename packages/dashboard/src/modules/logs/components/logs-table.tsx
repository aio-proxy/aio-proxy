import { m } from "@aio-proxy/i18n";
import type { DashboardRequestLog, DashboardRequestLogsResponse, RequestOutcome } from "@aio-proxy/types";
import { useForm } from "@tanstack/react-form";
import {
  type CellContext,
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { useState } from "react";
import { DataTablePagination } from "@/components/data-table-pagination";
import { ProtocolLabel } from "@/components/protocol-label";
import { TokenCount } from "@/components/token-count";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { displayTotalTokens, formatDuration, formatLogCost } from "../log-formatters";
import type { LogsSearch } from "../logs-search";

type Props = {
  readonly data: DashboardRequestLogsResponse;
  readonly search: LogsSearch;
  readonly onSearchChange: (search: LogsSearch) => void;
  readonly onSelect: (log: DashboardRequestLog) => void;
};

const outcomeLabel = (outcome: RequestOutcome) => m[`dashboard.logs.${outcome}`]();
const columnLabels: Record<string, () => string> = {
  completedAt: () => m["dashboard.logs.completed_at"](),
  outcome: () => m["dashboard.logs.outcome"](),
  inboundProtocol: () => m["dashboard.logs.protocol"](),
  requestedModelId: () => m["dashboard.logs.requested_model"](),
  finalProviderId: () => m["dashboard.logs.final_provider"](),
  finalModelId: () => m["dashboard.logs.final_model"](),
  finalStatusCode: () => m["dashboard.logs.status"](),
  durationMs: () => m["dashboard.logs.duration"](),
  tokens: () => m["dashboard.logs.tokens"](),
  cost: () => m["dashboard.logs.cost"](),
};
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
      <Badge variant="outline">{outcomeLabel(row.original.outcome)}</Badge>
    ),
  },
  {
    accessorKey: "inboundProtocol",
    header: () => m["dashboard.logs.protocol"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) => (
      <ProtocolLabel protocol={row.original.inboundProtocol} />
    ),
  },
  { accessorKey: "requestedModelId", header: () => m["dashboard.logs.requested_model"]() },
  {
    accessorKey: "finalProviderId",
    header: () => m["dashboard.logs.final_provider"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) =>
      row.original.finalProviderId ?? m["dashboard.logs.not_available"](),
  },
  {
    accessorKey: "finalModelId",
    header: () => m["dashboard.logs.final_model"](),
    cell: ({ row }: CellContext<DashboardRequestLog, unknown>) =>
      row.original.finalModelId ?? m["dashboard.logs.not_available"](),
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

export const LogsTable: React.FC<Props> = ({ data, search, onSearchChange, onSelect }) => {
  const [sorting, setSorting] = useState<import("@tanstack/react-table").SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<import("@tanstack/react-table").VisibilityState>({});
  const form = useForm({ defaultValues: { tableFilter: "" } });
  const table = useReactTable({
    data: data.items as DashboardRequestLog[],
    columns,
    state: {
      pagination: { pageIndex: search.page - 1, pageSize: search.pageSize },
      sorting,
      columnVisibility,
      globalFilter: form.state.values.tableFilter,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
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
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <form.Field name="tableFilter">
          {(field) => (
            <Field className="max-w-xs">
              <FieldLabel htmlFor="logs-page-filter">{m["dashboard.logs.search_page"]()}</FieldLabel>
              <Input
                id="logs-page-filter"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            {m["dashboard.logs.columns"]()}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table.getAllLeafColumns().map((column) => (
              <DropdownMenuItem key={column.id} onClick={() => column.toggleVisibility()}>
                {column.getIsVisible() && <Check />}
                {columnLabels[column.id]?.() ?? m["dashboard.logs.columns"]()}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="overflow-x-auto rounded-2xl border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id}>
                {group.headers.map((header) => (
                  <TableHead key={header.id}>
                    {header.isPlaceholder ? null : (
                      <Button variant="ghost" size="sm" onClick={header.column.getToggleSortingHandler()}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getIsSorted() === "asc" ? (
                          <ArrowUp />
                        ) : header.column.getIsSorted() === "desc" ? (
                          <ArrowDown />
                        ) : null}
                      </Button>
                    )}
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
