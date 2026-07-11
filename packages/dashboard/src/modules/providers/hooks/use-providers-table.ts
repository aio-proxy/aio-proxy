import { m } from "@aio-proxy/i18n";
import type { DashboardProviderSummary } from "@aio-proxy/types";
import {
  type ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { startCase } from "es-toolkit/string";

// Module scope keeps a stable `columns` identity for TanStack Table (no props/state deps).
const columns: ColumnDef<DashboardProviderSummary>[] = [
  { id: "kind", accessorKey: "kind", header: () => m["dashboard.providers.table.col_type"]() },
  { id: "id", accessorKey: "id", header: () => m["dashboard.providers.table.col_id"]() },
  {
    id: "name",
    accessorFn: (row) => row.name ?? startCase(row.id),
    header: () => m["dashboard.providers.table.col_name"](),
  },
  { id: "enabled", accessorKey: "enabled", header: () => m["dashboard.providers.table.col_enabled"]() },
  { id: "status", accessorKey: "last_status", header: () => m["dashboard.providers.table.col_status"]() },
  {
    id: "models",
    accessorFn: (row) => (row.clientModels ?? []).join(", "),
    header: () => m["dashboard.providers.table.col_models"](),
  },
  { id: "actions", enableSorting: false, cell: () => null, header: () => "" },
];

export function useProvidersTable(data: readonly DashboardProviderSummary[]) {
  return useReactTable({
    data: data as DashboardProviderSummary[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
}
