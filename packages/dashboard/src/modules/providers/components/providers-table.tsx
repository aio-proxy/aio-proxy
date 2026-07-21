import type { DashboardProviderSummary } from "@aio-proxy/types";
import type React from "react";

import { m } from "@aio-proxy/i18n";
import { useForm } from "@tanstack/react-form";
import { Link } from "@tanstack/react-router";
import { type ColumnDef, flexRender } from "@tanstack/react-table";
import { startCase } from "es-toolkit/string";
import { ChevronRight, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";

import { DataTablePagination } from "@/components/data-table-pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty } from "@/components/ui/empty";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useDataTable } from "@/hooks/use-data-table";
import { cn } from "@/lib/utils";

import { DeleteProviderDialog, type DeleteProviderDialogRef } from "./delete-provider-dialog";
import { ProviderModelsCell } from "./provider-models-cell";
import { ProviderStateCell } from "./provider-state-cell";

const kindLabels: Record<DashboardProviderSummary["kind"], () => string> = {
  api: () => m["dashboard.providers.kind_label.api"](),
  "ai-sdk": () => m["dashboard.providers.kind_label.ai-sdk"](),
  oauth: () => m["dashboard.providers.kind_label.oauth"](),
  invalid: () => m["dashboard.providers.kind_label.invalid"](),
};

const uneditableDiagnosticCodes = new Set(["PROVIDER_CONFIG_INVALID", "LEGACY_OAUTH_CONFIG_UNSUPPORTED"]);

const canEditProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind !== "invalid" &&
  (provider.state.diagnostic === undefined || !uneditableDiagnosticCodes.has(provider.state.diagnostic.code));

const displayName = (provider: DashboardProviderSummary): string => provider.name ?? startCase(provider.id);

interface ProvidersTableProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly focusProviderId?: string;
}

export const ProvidersTable: React.FC<ProvidersTableProps> = ({ providers, focusProviderId }) => {
  "use no memo";

  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const filterForm = useForm({ defaultValues: { providerFilter: "" } });
  const hasDetails = providers.some(
    (provider) =>
      provider.accountLabel !== undefined ||
      provider.plugin !== undefined ||
      provider.capability !== undefined ||
      provider.expiresAt !== undefined,
  );
  const columns = useMemo<ColumnDef<DashboardProviderSummary>[]>(
    () => [
      {
        id: "provider",
        accessorFn: (provider) => [displayName(provider), provider.id, kindLabels[provider.kind]()].join(" "),
        header: () => m["dashboard.providers.table.col_provider"](),
        cell: ({ row }) => {
          const provider = row.original;
          const name = displayName(provider);
          return (
            <div className="min-w-0 sm:min-w-40">
              {canEditProvider(provider) ? (
                <Link
                  id={`provider-link-${provider.id}`}
                  to="/providers/$id/edit"
                  params={{ id: provider.id }}
                  aria-label={m["dashboard.providers.actions.edit_provider"]({ id: provider.id })}
                  className="font-medium after:absolute after:inset-0 focus-visible:outline-none"
                >
                  {name}
                </Link>
              ) : (
                <div className="font-medium">{name}</div>
              )}
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>{provider.id}</span>
                <span aria-hidden="true">·</span>
                <span>{kindLabels[provider.kind]()}</span>
                <span className="sm:hidden" aria-hidden="true">
                  ·
                </span>
                <span className="sm:hidden" data-testid={`provider-mobile-models-${provider.id}`}>
                  {(provider.clientModels ?? []).length} {m["dashboard.providers.table.col_models"]()}
                </span>
              </div>
            </div>
          );
        },
      },
      {
        id: "status",
        accessorFn: (provider) => `${provider.enabled} ${provider.state.status} ${provider.state.catalog ?? ""}`,
        header: () => m["dashboard.providers.table.col_status"](),
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col items-start gap-1 sm:min-w-32 sm:flex-row sm:gap-2">
            <Badge variant={row.original.enabled ? "secondary" : "outline"}>
              {row.original.enabled
                ? m["dashboard.providers.badge.enabled"]()
                : m["dashboard.providers.badge.disabled"]()}
            </Badge>
            <div className="space-y-1 whitespace-normal">
              <ProviderStateCell provider={row.original} />
              {row.original.catalogLastSuccessAt === undefined ? null : (
                <div className="text-xs text-muted-foreground">
                  {m["dashboard.providers.catalog.last_success_at"]({
                    value: new Date(row.original.catalogLastSuccessAt).toLocaleString(),
                  })}
                </div>
              )}
            </div>
          </div>
        ),
      },
      ...(hasDetails
        ? [
            {
              id: "details",
              accessorFn: (provider) =>
                [provider.accountLabel, provider.plugin, provider.capability].filter(Boolean).join(" "),
              header: () => m["dashboard.providers.table.col_details"](),
              cell: ({ row }) => {
                const provider = row.original;
                const capability = [provider.plugin, provider.capability].filter(Boolean).join("/");
                if (provider.accountLabel === undefined && capability === "" && provider.expiresAt === undefined) {
                  return null;
                }
                return (
                  <div className="max-w-xs space-y-1 whitespace-normal">
                    {provider.accountLabel === undefined ? null : <div>{provider.accountLabel}</div>}
                    {capability === "" ? null : <div className="text-xs text-muted-foreground">{capability}</div>}
                    {provider.expiresAt === undefined ? null : (
                      <div className="text-xs text-muted-foreground">
                        {m["dashboard.providers.account.expires_at"]({
                          value: new Date(provider.expiresAt).toLocaleString(),
                        })}
                      </div>
                    )}
                  </div>
                );
              },
            } satisfies ColumnDef<DashboardProviderSummary>,
          ]
        : []),
      {
        id: "models",
        accessorFn: (provider) => (provider.clientModels ?? []).join(", "),
        header: () => m["dashboard.providers.table.col_models"](),
        cell: ({ row }) => <ProviderModelsCell models={row.original.clientModels ?? []} />,
      },
      {
        id: "actions",
        enableSorting: false,
        header: () => "",
        cell: ({ row }) =>
          canEditProvider(row.original) ? (
            <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={m["dashboard.providers.actions.delete_provider"]({ id: row.original.id })}
              onClick={() => deleteDialogRef.current?.open(row.original)}
            >
              <Trash2 />
            </Button>
          ),
      },
    ],
    [hasDetails],
  );
  const { table } = useDataTable(providers, columns);

  useEffect(() => {
    if (focusProviderId === undefined) return;
    const rowIndex = table.getPrePaginationRowModel().rows.findIndex((row) => row.original.id === focusProviderId);
    if (rowIndex < 0) return;
    table.setPageIndex(Math.floor(rowIndex / table.getState().pagination.pageSize));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = document.getElementById(`provider-row-${focusProviderId}`);
        row?.scrollIntoView?.({ block: "center" });
        (document.getElementById(`provider-link-${focusProviderId}`) ?? row)?.focus();
      });
    });
  }, [focusProviderId, table]);

  if (providers.length === 0) {
    return <Empty>{m["dashboard.providers.empty_state"]()}</Empty>;
  }

  return (
    <div className="flex flex-col gap-4">
      <filterForm.Field name="providerFilter">
        {(field) => (
          <Field className="max-w-sm">
            <FieldLabel htmlFor="providers-table-filter" className="sr-only">
              {m["dashboard.providers.table.filter"]()}
            </FieldLabel>
            <Input
              id="providers-table-filter"
              value={field.state.value}
              placeholder={m["dashboard.providers.table.filter_placeholder"]()}
              onChange={(event) => {
                field.handleChange(event.target.value);
                table.setGlobalFilter(event.target.value);
              }}
            />
          </Field>
        )}
      </filterForm.Field>
      <Table aria-label={m["dashboard.providers.table.label"]()} data-testid="providers-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={cn(
                    header.column.id === "details" && "hidden lg:table-cell",
                    header.column.id === "models" && "hidden w-20 text-right sm:table-cell",
                    header.column.id === "actions" && "w-8 px-1 sm:w-12 sm:px-3",
                  )}
                >
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
              id={`provider-row-${row.original.id}`}
              tabIndex={-1}
              data-testid={`provider-row-${row.original.id}`}
              data-focused={row.original.id === focusProviderId ? "true" : undefined}
              className={cn(
                "relative",
                canEditProvider(row.original) &&
                  "cursor-pointer focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-ring/40",
                row.original.id === focusProviderId && "bg-accent ring-2 ring-ring/40",
              )}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={cn(
                    cell.column.id === "details" && "hidden lg:table-cell",
                    cell.column.id === "models" && "relative z-10 hidden w-20 text-right sm:table-cell",
                    cell.column.id === "actions" && "relative z-10 w-8 px-1 sm:w-12 sm:px-3",
                  )}
                >
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {table.getPageCount() > 1 ? <DataTablePagination table={table} /> : null}
      <DeleteProviderDialog ref={deleteDialogRef} />
    </div>
  );
};
