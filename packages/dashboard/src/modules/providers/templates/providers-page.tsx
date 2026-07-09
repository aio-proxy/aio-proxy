import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { flexRender } from "@tanstack/react-table";
import type React from "react";
import { useState } from "react";
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
import { DeleteProviderDialog } from "../components/delete-provider-dialog";
import { ProviderActionsMenu } from "../components/provider-actions-menu";
import { ProviderKindBadge } from "../components/provider-kind-badge";
import { useProvidersTable } from "../hooks/use-providers-table";
import { providersQueryOptions } from "../services/providers-service";

export const ProvidersPage: React.FC = () => {
  const { data, isLoading } = useQuery(providersQueryOptions());
  const providers = data?.providers ?? [];
  const table = useProvidersTable(providers);
  const [deleteTarget, setDeleteTarget] = useState<DashboardProviderSummary | null>(null);

  return (
    <PageContainer
      title={m["dashboard.providers.list_title"]()}
      extra={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button data-testid="new-provider-button">{m["dashboard.providers.new_provider"]()}</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to="/providers/new/$kind" params={{ kind: "api" }}>
                {m["dashboard.providers.kind_label.api"]()}
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link to="/providers/new/$kind" params={{ kind: "ai-sdk" }}>
                {m["dashboard.providers.kind_label.ai-sdk"]()}
              </Link>
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
                <TableCell>
                  <ProviderKindBadge kind={row.original.kind} />
                </TableCell>
                <TableCell>{row.original.id}</TableCell>
                <TableCell>{row.original.name ?? row.original.id}</TableCell>
                <TableCell>{row.original.enabled ? "✓" : "—"}</TableCell>
                <TableCell>{row.original.last_status}</TableCell>
                <TableCell>{(row.original.clientModels ?? []).join(", ")}</TableCell>
                <TableCell>{row.original.weight ?? "—"}</TableCell>
                <TableCell>
                  <ProviderActionsMenu provider={row.original} onDelete={() => setDeleteTarget(row.original)} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {deleteTarget && (
        <DeleteProviderDialog
          provider={deleteTarget}
          open={true}
          onOpenChange={(open) => {
            if (!open) setDeleteTarget(null);
          }}
        />
      )}
    </PageContainer>
  );
};
