import type { DashboardProviderSummary } from "@aio-proxy/types";
import type { ColumnDef } from "@tanstack/react-table";
import { useDataTable } from "@/hooks/use-data-table";

export function useProvidersTable(
  data: readonly DashboardProviderSummary[],
  columns: readonly ColumnDef<DashboardProviderSummary>[],
) {
  return useDataTable(data, columns);
}
