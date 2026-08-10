import {
  type ColumnDef,
  columnFilteringFeature,
  columnVisibilityFeature,
  createExpandedRowModel,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  type PaginationState,
  type RowData,
  rowExpandingFeature,
  rowPaginationFeature,
  rowSortingFeature,
  type SortingState,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import { useState } from 'react';

export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnVisibilityFeature,
  globalFilteringFeature,
  filteredRowModel: createFilteredRowModel(),
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  rowExpandingFeature,
  expandedRowModel: createExpandedRowModel(),
  rowPaginationFeature,
  paginatedRowModel: createPaginatedRowModel(),
});

export type DataTableFeatures = typeof dataTableFeatures;

interface UseDataTableOptions<TData extends RowData> {
  readonly getRowId?: (row: TData) => string;
  readonly getSubRows?: (row: TData) => TData[] | undefined;
}

export function useDataTable<TData extends RowData>(
  data: readonly TData[],
  columns: readonly ColumnDef<DataTableFeatures, TData>[],
  options: UseDataTableOptions<TData> = {},
) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [globalFilter, setGlobalFilter] = useState('');
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});

  const table = useTable({
    features: dataTableFeatures,
    data: data as TData[],
    columns: columns as ColumnDef<DataTableFeatures, TData>[],
    state: { sorting, pagination, globalFilter, columnVisibility },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    onGlobalFilterChange: setGlobalFilter,
    onColumnVisibilityChange: setColumnVisibility,
    ...(options.getRowId === undefined ? {} : { getRowId: options.getRowId }),
    ...(options.getSubRows === undefined ? {} : { getSubRows: options.getSubRows }),
    paginateExpandedRows: options.getSubRows === undefined,
  });

  return { table };
}
