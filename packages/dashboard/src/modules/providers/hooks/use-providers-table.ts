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

export function useProvidersTable(data: readonly DashboardProviderSummary[]) {
  const columns: ColumnDef<DashboardProviderSummary>[] = [
    { id: "kind", accessorKey: "kind" },
    { id: "id", accessorKey: "id" },
    { id: "name", accessorFn: (row) => row.name ?? startCase(row.id) },
    { id: "enabled", accessorKey: "enabled" },
    { id: "status", accessorKey: "last_status" },
    { id: "models", accessorFn: (row) => (row.clientModels ?? []).join(", ") },
    { id: "weight", accessorKey: "weight" },
    { id: "actions", enableSorting: false, cell: () => null },
  ];

  return useReactTable({
    data: data as DashboardProviderSummary[],
    columns,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
}
