import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ColumnDef, flexRender } from "@tanstack/react-table";
import { startCase } from "es-toolkit/string";
import type React from "react";
import { useMemo, useRef } from "react";
import { DataTableHeaderCell } from "@/components/data-table-header-cell";
import { DataTablePagination } from "@/components/data-table-pagination";
import { DataTableToolbar } from "@/components/data-table-toolbar";
import { PageContainer } from "@/components/page-container";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Empty } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { useDataTable } from "@/hooks/use-data-table";
import { DeleteProviderDialog, type DeleteProviderDialogRef } from "../components/delete-provider-dialog";
import { PluginsTable } from "../components/plugins-table";
import { ProviderActionsMenu } from "../components/provider-actions-menu";
import { ProviderModelsCell } from "../components/provider-models-cell";
import { ProviderStateCell } from "../components/provider-state-cell";
import { pluginsQueryOptions } from "../services/plugins-service";
import { providersQueryOptions } from "../services/providers-service";

const kindLabels: Record<DashboardProviderSummary["kind"], () => string> = {
  api: () => m["dashboard.providers.kind_label.api"](),
  "ai-sdk": () => m["dashboard.providers.kind_label.ai-sdk"](),
  oauth: () => m["dashboard.providers.kind_label.oauth"](),
  invalid: () => m["dashboard.providers.kind_label.invalid"](),
};

const columnLabels: Record<string, () => string> = {
  kind: () => m["dashboard.providers.table.col_type"](),
  id: () => m["dashboard.providers.table.col_id"](),
  name: () => m["dashboard.providers.table.col_name"](),
  enabled: () => m["dashboard.providers.table.col_enabled"](),
  state: () => m["dashboard.providers.table.col_state"](),
  capability: () => m["dashboard.providers.table.col_capability"](),
  account: () => m["dashboard.providers.table.col_account"](),
  catalog: () => m["dashboard.providers.table.col_catalog"](),
  models: () => m["dashboard.providers.table.col_models"](),
  actions: () => m["dashboard.providers.table.col_actions"](),
};

export const ProvidersPage: React.FC = () => {
  "use no memo";

  // TanStack exposes changing state through a stable mutable table instance.
  const providersQuery = useQuery(providersQueryOptions());
  const pluginsQuery = useQuery(pluginsQueryOptions());
  const providers = providersQuery.data?.providers ?? [];
  const plugins = pluginsQuery.data?.plugins ?? [];
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const columns = useMemo<ColumnDef<DashboardProviderSummary>[]>(
    () => [
      {
        id: "kind",
        accessorKey: "kind",
        header: () => m["dashboard.providers.table.col_type"](),
        cell: ({ row }) => kindLabels[row.original.kind](),
      },
      { id: "id", accessorKey: "id", header: () => m["dashboard.providers.table.col_id"]() },
      {
        id: "name",
        accessorFn: (row) => row.name ?? startCase(row.id),
        header: () => m["dashboard.providers.table.col_name"](),
      },
      {
        id: "enabled",
        accessorKey: "enabled",
        header: () => m["dashboard.providers.table.col_enabled"](),
        cell: ({ row }) =>
          row.original.enabled ? m["dashboard.providers.badge.enabled"]() : m["dashboard.providers.badge.disabled"](),
      },
      {
        id: "state",
        accessorFn: (row) => row.state.status,
        header: () => m["dashboard.providers.table.col_state"](),
        cell: ({ row }) => <ProviderStateCell provider={row.original} />,
      },
      {
        id: "capability",
        accessorFn: (row) => [row.plugin, row.capability].filter(Boolean).join("/"),
        header: () => m["dashboard.providers.table.col_capability"](),
        cell: ({ row }) =>
          row.original.plugin === undefined || row.original.capability === undefined
            ? m["dashboard.providers.diagnostics.not_available"]()
            : `${row.original.plugin}/${row.original.capability}`,
      },
      {
        id: "account",
        accessorFn: (row) => row.accountLabel ?? "",
        header: () => m["dashboard.providers.table.col_account"](),
        cell: ({ row }) => (
          <div>
            <div>{row.original.accountLabel ?? m["dashboard.providers.diagnostics.not_available"]()}</div>
            {row.original.expiresAt === undefined ? null : (
              <div className="text-muted-foreground text-xs">
                {m["dashboard.providers.account.expires_at"]({
                  value: new Date(row.original.expiresAt).toISOString(),
                })}
              </div>
            )}
          </div>
        ),
      },
      {
        id: "catalog",
        accessorFn: (row) => (row.state.status === "ready" ? (row.state.catalog ?? "") : ""),
        header: () => m["dashboard.providers.table.col_catalog"](),
        cell: ({ row }) => (
          <div>
            <div>
              {row.original.state.status === "ready" && row.original.state.catalog !== undefined
                ? row.original.state.catalog === "fresh"
                  ? m["dashboard.providers.state.catalog_fresh"]()
                  : m["dashboard.providers.state.catalog_stale"]()
                : m["dashboard.providers.diagnostics.not_available"]()}
            </div>
            {row.original.catalogLastSuccessAt === undefined ? null : (
              <div className="text-muted-foreground text-xs">
                {m["dashboard.providers.catalog.last_success_at"]({ value: row.original.catalogLastSuccessAt })}
              </div>
            )}
          </div>
        ),
      },
      {
        id: "models",
        accessorFn: (row) => (row.clientModels ?? []).join(", "),
        header: () => m["dashboard.providers.table.col_models"](),
        cell: ({ row }) => <ProviderModelsCell models={row.original.clientModels ?? []} />,
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => "",
        cell: ({ row }) => (
          <ProviderActionsMenu provider={row.original} onDelete={() => deleteDialogRef.current?.open(row.original)} />
        ),
      },
    ],
    [],
  );
  const { table, columnVisibility } = useDataTable(providers, columns);
  const isLoading = providersQuery.isLoading || pluginsQuery.isLoading;

  return (
    <PageContainer
      title={m["dashboard.providers.list_title"]()}
      extra={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button data-testid="new-provider-button" />}>
            {m["dashboard.providers.new_provider"]()}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem render={<Link preload="intent" to="/providers/new/$kind" params={{ kind: "api" }} />}>
              {m["dashboard.providers.kind_label.api"]()}
            </DropdownMenuItem>
            <DropdownMenuItem render={<Link preload="intent" to="/providers/new/$kind" params={{ kind: "ai-sdk" }} />}>
              {m["dashboard.providers.kind_label.ai-sdk"]()}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => {
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton array
            return <Skeleton key={i} className="h-12 w-full" />;
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-8">
          <section className="space-y-3" aria-labelledby="plugins-heading">
            <h2 id="plugins-heading" className="font-semibold text-sm">
              {m["dashboard.providers.plugins.title"]()}
            </h2>
            <PluginsTable plugins={plugins} />
          </section>

          <section className="space-y-3" aria-labelledby="providers-heading">
            <h2 id="providers-heading" className="font-semibold text-sm">
              {m["dashboard.providers.providers_title"]()}
            </h2>
            {providers.length === 0 ? (
              <Empty>{m["dashboard.providers.empty_state"]()}</Empty>
            ) : (
              <div className="flex flex-col gap-4">
                <DataTableToolbar
                  table={table}
                  columnVisibility={columnVisibility}
                  filterId="providers-table-filter"
                  filterLabel={m["dashboard.providers.table.filter"]()}
                  columnsLabel={m["dashboard.providers.table.columns"]()}
                  columnLabel={(columnId) => columnLabels[columnId]?.() ?? m["dashboard.providers.table.columns"]()}
                />
                <Table aria-label={m["dashboard.providers.table.label"]()} data-testid="providers-table">
                  <TableHeader>
                    {table.getHeaderGroups().map((headerGroup) => (
                      <TableRow key={headerGroup.id}>
                        {headerGroup.headers.map((header) => (
                          <DataTableHeaderCell
                            key={header.id}
                            label={
                              header.isPlaceholder
                                ? null
                                : flexRender(header.column.columnDef.header, header.getContext())
                            }
                            canSort={!header.isPlaceholder && header.column.getCanSort()}
                            sortDirection={header.column.getIsSorted()}
                            onToggleSorting={header.column.getToggleSortingHandler()}
                          />
                        ))}
                      </TableRow>
                    ))}
                  </TableHeader>
                  <TableBody>
                    {table.getRowModel().rows.map((row) => (
                      <TableRow key={row.id} data-testid={`provider-row-${row.original.id}`}>
                        {row.getVisibleCells().map((cell) => (
                          <TableCell key={cell.id}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <DataTablePagination table={table} />
              </div>
            )}
          </section>
        </div>
      )}
      <DeleteProviderDialog ref={deleteDialogRef} />
    </PageContainer>
  );
};
