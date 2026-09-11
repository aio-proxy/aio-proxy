import { getLocale, m } from '@aio-proxy/i18n';
import type { SyncHistoryItem } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { Checkbox } from '@aio-proxy/ui/components/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@aio-proxy/ui/components/dialog';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@aio-proxy/ui/components/select';
import { Skeleton } from '@aio-proxy/ui/components/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { useForm } from '@tanstack/react-form';
import { useQuery } from '@tanstack/react-query';
import {
  columnFilteringFeature,
  columnVisibilityFeature,
  createColumnHelper,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
} from '@tanstack/react-table';
import type { PaginationState } from '@tanstack/react-table';
import { useMemo, useState } from 'react';

import { syncHistoryQueryOptions } from '../../services/sync-service';

const EMPTY_HISTORY: readonly SyncHistoryItem[] = [];
const HISTORY_FEATURES = tableFeatures({
  columnFilteringFeature,
  globalFilteringFeature,
  rowSortingFeature,
  rowPaginationFeature,
  columnVisibilityFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
});
const HISTORY_COLUMN_HELPER = createColumnHelper<typeof HISTORY_FEATURES, SyncHistoryItem>();

export interface SyncHistoryDialogProps {
  readonly objectId: string | null;
  readonly open: boolean;
  onOpenChange(open: boolean): void;
}

export const SyncHistoryDialog: React.FC<SyncHistoryDialogProps> = ({ objectId, open, onOpenChange }) => {
  const query = useQuery(syncHistoryQueryOptions(objectId ?? ''));
  const [sorting, setSorting] = useState<{ id: string; desc: boolean }[]>([]);
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 10 });
  const [showColumns, setShowColumns] = useState(false);
  const form = useForm({
    defaultValues: {
      filter: '',
      pageSize: '10',
      visibleColumns: { operationId: true, writtenAt: true, current: true } as Record<string, boolean>,
    },
  });
  const { filter, visibleColumns } = form.state.values;
  const columns = useMemo(
    () =>
      HISTORY_COLUMN_HELPER.columns([
        HISTORY_COLUMN_HELPER.accessor('operationId', {
          header: (context) => {
            const sorted = context.column.getIsSorted();
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={m['dashboard.sync.history_operation']()}
                aria-pressed={sorted !== false}
                onClick={context.column.getToggleSortingHandler()}
              >
                {m['dashboard.sync.history_operation']()}
                {sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ''}
              </Button>
            );
          },
          cell: (context) => <code className="text-xs">{String(context.getValue())}</code>,
        }),
        HISTORY_COLUMN_HELPER.accessor('writtenAt', {
          header: (context) => {
            const sorted = context.column.getIsSorted();
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={m['dashboard.sync.history_written']()}
                aria-pressed={sorted !== false}
                onClick={context.column.getToggleSortingHandler()}
              >
                {m['dashboard.sync.history_written']()}
                {sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ''}
              </Button>
            );
          },
          cell: (context) => {
            const date = new Date(Number(context.getValue()));
            return <time dateTime={date.toISOString()}>{date.toLocaleString(getLocale())}</time>;
          },
        }),
        HISTORY_COLUMN_HELPER.accessor('current', {
          header: (context) => {
            const sorted = context.column.getIsSorted();
            return (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={m['dashboard.sync.history_current']()}
                aria-pressed={sorted !== false}
                onClick={context.column.getToggleSortingHandler()}
              >
                {m['dashboard.sync.history_current']()}
                {sorted === 'asc' ? ' ↑' : sorted === 'desc' ? ' ↓' : ''}
              </Button>
            );
          },
          cell: (context) =>
            context.getValue() ? m['dashboard.sync.history_yes']() : m['dashboard.sync.history_no'](),
        }),
      ]),
    [],
  );
  const table = useTable({
    data: query.data ?? EMPTY_HISTORY,
    columns,
    features: HISTORY_FEATURES,
    state: {
      globalFilter: filter,
      sorting,
      pagination,
      columnVisibility: Object.fromEntries(
        Object.entries(visibleColumns).map(([columnId, visible]) => [columnId, visible]),
      ),
    },
    onGlobalFilterChange: (next) => form.setFieldValue('filter', String(next ?? '')),
    onSortingChange: setSorting,
    onPaginationChange: (next) => {
      setPagination((current) => {
        const resolved = typeof next === 'function' ? next(current) : next;
        form.setFieldValue('pageSize', String(resolved.pageSize));
        return resolved;
      });
    },
    onColumnVisibilityChange: (next) => {
      const resolved = typeof next === 'function' ? next(visibleColumns) : next;
      form.setFieldValue('visibleColumns', resolved);
    },
  });
  const pageCount = Math.max(table.getPageCount(), 1);
  const page = Math.min(table.state.pagination.pageIndex + 1, pageCount);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" closeLabel={m['common.close']()}>
        <DialogHeader>
          <DialogTitle>{m['dashboard.sync.history_title']()}</DialogTitle>
          <DialogDescription>{objectId ?? ''}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-end gap-3">
          <form.Field name="filter">
            {(field) => (
              <Field className="min-w-52 flex-1">
                <FieldLabel htmlFor="sync-history-filter">{m['dashboard.sync.history_filter']()}</FieldLabel>
                <Input
                  id="sync-history-filter"
                  placeholder={m['dashboard.sync.history_filter_placeholder']()}
                  value={field.state.value}
                  onChange={(event) => {
                    field.handleChange(event.target.value);
                    table.setGlobalFilter(event.target.value);
                    setPagination((current) => ({ ...current, pageIndex: 0 }));
                  }}
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="pageSize">
            {(field) => (
              <Field>
                <FieldLabel htmlFor="sync-history-page-size">{m['dashboard.sync.history_page_size']()}</FieldLabel>
                <Select
                  value={field.state.value}
                  onValueChange={(value) => {
                    if (value === null) return;
                    field.handleChange(value);
                    table.setPageSize(Number(value));
                  }}
                >
                  <SelectTrigger id="sync-history-page-size" className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 25, 50].map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <Button type="button" variant="outline" onClick={() => setShowColumns((current) => !current)}>
            {m['dashboard.sync.history_columns']()}
          </Button>
        </div>
        {showColumns ? (
          <form.Field name="visibleColumns">
            {(field) => (
              <div
                className="flex flex-wrap gap-3 rounded-lg border p-3"
                aria-label={m['dashboard.sync.history_columns']()}
              >
                {(
                  [
                    ['operationId', m['dashboard.sync.history_show_operation']()],
                    ['writtenAt', m['dashboard.sync.history_show_written']()],
                    ['current', m['dashboard.sync.history_show_current']()],
                  ] as const
                ).map(([columnId, label]) => (
                  <label key={columnId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={Boolean(field.state.value[columnId])}
                      onCheckedChange={(checked) =>
                        field.handleChange({ ...field.state.value, [columnId]: checked === true })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
            )}
          </form.Field>
        ) : null}
        {query.isLoading ? <Skeleton className="h-32 w-full" aria-label={m['dashboard.sync.loading']()} /> : null}
        {query.isError ? <p role="alert">{m['dashboard.sync.load_failed']()}</p> : null}
        {!query.isLoading && !query.isError && table.getRowModel().rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m['dashboard.sync.history_empty']()}</p>
        ) : null}
        {!query.isLoading && !query.isError && table.getRowModel().rows.length > 0 ? (
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        <table.FlexRender cell={cell} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
          <span>{m['dashboard.sync.history_page']({ page, pages: pageCount })}</span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => table.previousPage()}
              disabled={!table.getCanPreviousPage()}
            >
              {m['dashboard.sync.history_previous']()}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => table.nextPage()}
              disabled={!table.getCanNextPage()}
            >
              {m['dashboard.sync.history_next']()}
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {m['common.close']()}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
