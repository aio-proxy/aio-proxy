import type { DashboardProviderSummary } from "@aio-proxy/types";
import {
  type ColumnDef,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";

export function useProvidersTable(
  data: readonly DashboardProviderSummary[],
  columns: readonly ColumnDef<DashboardProviderSummary>[],
) {
  return useReactTable({
    data: data as DashboardProviderSummary[],
    columns: columns as ColumnDef<DashboardProviderSummary>[],
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });
}
