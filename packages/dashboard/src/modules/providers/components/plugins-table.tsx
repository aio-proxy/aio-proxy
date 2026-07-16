import { getLocale, m } from "@aio-proxy/i18n";
import type { DashboardPluginSummary } from "@aio-proxy/types";
import { type ColumnDef, flexRender } from "@tanstack/react-table";
import type React from "react";
import { DataTableHeaderCell } from "@/components/data-table-header-cell";
import { DataTablePagination } from "@/components/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table-toolbar";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { useDataTable } from "@/hooks/use-data-table";
import { DiagnosticDetails } from "./diagnostic-details";

type DashboardLocalizedText = NonNullable<DashboardPluginSummary["label"]>;

const resolvePluginCopy = (text: DashboardLocalizedText): string => {
  if (typeof text === "string") return text;
  try {
    const exact = Intl.getCanonicalLocales(getLocale())[0];
    if (exact === undefined) return text.default;
    const parsed = new Intl.Locale(exact);
    const languageScript = parsed.script === undefined ? undefined : `${parsed.language}-${parsed.script}`;
    for (const candidate of [exact, languageScript, parsed.language]) {
      if (candidate !== undefined && text[candidate] !== undefined) return text[candidate];
    }
  } catch {}
  return text.default;
};

const columns: ColumnDef<DashboardPluginSummary>[] = [
  {
    accessorKey: "packageName",
    header: () => m["dashboard.providers.plugins.table.col_package"](),
    cell: ({ row }) => (
      <div>
        {row.original.label === undefined ? null : <div>{resolvePluginCopy(row.original.label)}</div>}
        <div>{row.original.packageName}</div>
        {row.original.description === undefined ? null : (
          <div className="text-muted-foreground text-xs">{resolvePluginCopy(row.original.description)}</div>
        )}
      </div>
    ),
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

export const PluginsTable: React.FC<{ readonly plugins: readonly DashboardPluginSummary[] }> = ({ plugins }) => {
  "use no memo";

  // TanStack exposes changing state through a stable mutable table instance.
  const { table, columnVisibilityForm } = useDataTable(plugins, columns);

  return (
    <div className="space-y-4">
      <DataTableToolbar
        table={table}
        columnVisibilityForm={columnVisibilityForm}
        filterId="plugins-table-filter"
        filterLabel={m["dashboard.providers.plugins.table.filter"]()}
        columnsLabel={m["dashboard.providers.plugins.table.columns"]()}
        columnLabel={(columnId) => columnLabels[columnId]?.() ?? m["dashboard.providers.plugins.table.columns"]()}
      />
      <Table aria-label={m["dashboard.providers.plugins.table.label"]()} data-testid="plugins-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <DataTableHeaderCell
                  key={header.id}
                  label={header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                  canSort={!header.isPlaceholder && header.column.getCanSort()}
                  sortDirection={header.column.getIsSorted()}
                  onToggleSorting={header.column.getToggleSortingHandler()}
                />
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
