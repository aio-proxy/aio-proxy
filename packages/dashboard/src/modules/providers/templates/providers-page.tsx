import { m } from "@aio-proxy/i18n";
import { ProviderKind } from "@aio-proxy/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { flexRender } from "@tanstack/react-table";
import { startCase } from "es-toolkit/string";
import type React from "react";
import { useRef } from "react";
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
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeleteProviderDialog, type DeleteProviderDialogRef } from "../components/delete-provider-dialog";
import { ProviderActionsMenu } from "../components/provider-actions-menu";
import { ProviderModelsCell } from "../components/provider-models-cell";
import { useProvidersTable } from "../hooks/use-providers-table";
import { providersQueryOptions } from "../services/providers-service";

const kindLabels: Record<ProviderKind, () => string> = {
  [ProviderKind.Api]: () => m["dashboard.providers.kind_label.api"](),
  [ProviderKind.AiSdk]: () => m["dashboard.providers.kind_label.ai-sdk"](),
  [ProviderKind.OAuth]: () => m["dashboard.providers.kind_label.oauth"](),
};

export const ProvidersPage: React.FC = () => {
  const { data, isLoading } = useQuery(providersQueryOptions());
  const providers = data?.providers ?? [];
  const table = useProvidersTable(providers);
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);

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
      ) : providers.length === 0 ? (
        <Empty>{m["dashboard.providers.empty_state"]()}</Empty>
      ) : (
        <div className="flex flex-col gap-4">
          <Table data-testid="providers-table">
            <TableHeader>
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => (
                    <TableHead key={header.id}>
                      {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-testid={`provider-row-${row.original.id}`}>
                  <TableCell>{kindLabels[row.original.kind]()}</TableCell>
                  <TableCell>{row.original.id}</TableCell>
                  <TableCell>{row.original.name ?? startCase(row.original.id)}</TableCell>
                  <TableCell>{row.original.enabled ? "✓" : "—"}</TableCell>
                  <TableCell>{row.original.last_status}</TableCell>
                  <TableCell>
                    <ProviderModelsCell models={row.original.clientModels ?? []} />
                  </TableCell>
                  <TableCell>
                    <ProviderActionsMenu
                      provider={row.original}
                      onDelete={() => deleteDialogRef.current?.open(row.original)}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-muted-foreground text-sm">
              {m["dashboard.providers.table.pagination_summary"]({
                page: table.getState().pagination.pageIndex + 1,
                pages: table.getPageCount(),
              })}
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!table.getCanPreviousPage()}
                onClick={() => table.previousPage()}
              >
                {m["dashboard.providers.table.pagination_previous"]()}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!table.getCanNextPage()}
                onClick={() => table.nextPage()}
              >
                {m["dashboard.providers.table.pagination_next"]()}
              </Button>
            </div>
          </div>
        </div>
      )}
      <DeleteProviderDialog ref={deleteDialogRef} />
    </PageContainer>
  );
};
