import { m } from "@aio-proxy/i18n";
import type { DashboardPluginSummary } from "@aio-proxy/types";
import { useForm, useStore } from "@tanstack/react-form";
import {
  type ColumnDef,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { type FC, useState } from "react";
import { DataTablePagination } from "@/components/data-table-pagination";
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
import { DiagnosticDetails } from "./diagnostic-details";

const columns: ColumnDef<DashboardPluginSummary>[] = [
  {
    accessorKey: "packageName",
    header: () => m["dashboard.providers.plugins.table.col_package"](),
  },
  {
    id: "source",
    accessorFn: (plugin) => plugin.builtIn,
    header: () => m["dashboard.providers.plugins.table.col_source"](),
    cell: ({ row }) =>
      row.original.builtIn
        ? m["dashboard.providers.plugins.source_builtin"]()
        : m["dashboard.providers.plugins.source_third_party"](),
  },
  {
    accessorKey: "version",
    header: () => m["dashboard.providers.plugins.table.col_version"](),
    cell: ({ row }) => row.original.version ?? m["dashboard.providers.diagnostics.not_available"](),
  },
  {
    id: "state",
    accessorFn: (plugin) => plugin.state.status,
    header: () => m["dashboard.providers.plugins.table.col_state"](),
    cell: ({ row }) =>
      row.original.state.status === "ready"
        ? m["dashboard.providers.state.ready"]()
        : m["dashboard.providers.state.failed"](),
  },
  {
    id: "diagnostic",
    header: () => m["dashboard.providers.plugins.table.col_diagnostic"](),
    cell: ({ row }) =>
      row.original.state.status === "failed" ? (
        <DiagnosticDetails
          diagnostic={row.original.state.diagnostic}
          suggestedCommand={row.original.state.diagnostic.suggestedCommand}
        />
      ) : (
        m["dashboard.providers.diagnostics.not_available"]()
      ),
  },
];

const columnLabels: Record<string, () => string> = {
  packageName: () => m["dashboard.providers.plugins.table.col_package"](),
  source: () => m["dashboard.providers.plugins.table.col_source"](),
  version: () => m["dashboard.providers.plugins.table.col_version"](),
  state: () => m["dashboard.providers.plugins.table.col_state"](),
  diagnostic: () => m["dashboard.providers.plugins.table.col_diagnostic"](),
};

export const PluginsTable: FC<{ readonly plugins: readonly DashboardPluginSummary[] }> = ({ plugins }) => {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const form = useForm({ defaultValues: { tableFilter: "" } });
  const tableFilter = useStore(form.store, (state) => state.values.tableFilter);
  const table = useReactTable({
    data: plugins as DashboardPluginSummary[],
    columns,
    state: {
      sorting,
      columnVisibility,
      globalFilter: tableFilter,
    },
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <form.Field name="tableFilter">
          {(field) => (
            <Field className="max-w-xs">
              <FieldLabel htmlFor="plugins-table-filter">{m["dashboard.providers.plugins.table.filter"]()}</FieldLabel>
              <Input
                id="plugins-table-filter"
                value={field.state.value}
                onChange={(event) => field.handleChange(event.target.value)}
              />
            </Field>
          )}
        </form.Field>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            {m["dashboard.providers.plugins.table.columns"]()}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {table.getAllLeafColumns().map((column) => (
              <DropdownMenuItem key={column.id} onClick={() => column.toggleVisibility()}>
                {column.getIsVisible() && <Check />}
                {columnLabels[column.id]?.() ?? m["dashboard.providers.plugins.table.columns"]()}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Table aria-label={m["dashboard.providers.plugins.table.label"]()} data-testid="plugins-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  aria-sort={
                    header.column.getIsSorted() === "asc"
                      ? "ascending"
                      : header.column.getIsSorted() === "desc"
                        ? "descending"
                        : "none"
                  }
                >
                  {header.isPlaceholder ? null : header.column.getCanSort() ? (
                    <Button variant="ghost" size="sm" onClick={header.column.getToggleSortingHandler()}>
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {header.column.getIsSorted() === "asc" ? (
                        <ArrowUp />
                      ) : header.column.getIsSorted() === "desc" ? (
                        <ArrowDown />
                      ) : null}
                    </Button>
                  ) : (
                    flexRender(header.column.columnDef.header, header.getContext())
                  )}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={table.getVisibleLeafColumns().length}>
                {m["dashboard.providers.plugins.empty"]()}
              </TableCell>
            </TableRow>
          ) : (
            table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} data-testid={`plugin-row-${row.original.packageName}`}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <DataTablePagination table={table} />
    </div>
  );
};
