import { useForm } from '@tanstack/react-form';
import { useSelector } from '@tanstack/react-store';
import {
  type ColumnDef,
  type ColumnFiltersState,
  getExpandedRowModel,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  type PaginationState,
  type SortingState,
  useReactTable,
  type VisibilityState,
} from '@tanstack/react-table';
import { useState } from 'react';

const useColumnVisibilityForm = () =>
  useForm({
    defaultValues: { columnVisibility: {} as VisibilityState },
  });

export type ColumnVisibilityForm = ReturnType<typeof useColumnVisibilityForm>;

interface UseDataTableOptions<TData> {
  readonly getRowId?: (row: TData) => string;
  readonly getSubRows?: (row: TData) => TData[] | undefined;
}

export function useDataTable<TData>(
  data: readonly TData[],
  columns: readonly ColumnDef<TData>[],
  options: UseDataTableOptions<TData> = {},
) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const columnVisibilityForm = useColumnVisibilityForm();
  const columnVisibility = useSelector(columnVisibilityForm.store, (state) => state.values.columnVisibility);

  const table = useReactTable({
    data: data as TData[],
    columns: columns as ColumnDef<TData>[],
    state: { sorting, columnFilters, columnVisibility, globalFilter, pagination },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: (updater) =>
      columnVisibilityForm.setFieldValue('columnVisibility', (value) =>
        typeof updater === 'function' ? updater(value) : updater,
      ),
    onGlobalFilterChange: setGlobalFilter,
    onPaginationChange: setPagination,
    ...(options.getRowId === undefined ? {} : { getRowId: options.getRowId }),
    ...(options.getSubRows === undefined ? {} : { getSubRows: options.getSubRows }),
    getCoreRowModel: getCoreRowModel(),
    getExpandedRowModel: getExpandedRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    paginateExpandedRows: options.getSubRows === undefined,
  });

  return { table, columnVisibilityForm };
}
