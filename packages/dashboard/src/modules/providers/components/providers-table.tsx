import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useForm } from '@tanstack/react-form';
import { flexRender } from '@tanstack/react-table';
import type React from 'react';
import { useEffect, useMemo, useRef } from 'react';

import { DataTablePagination } from '@/components/data-table-pagination';
import { useDataTable } from '@/hooks/use-data-table';

import { DeleteProviderDialog, type DeleteProviderDialogRef } from './delete-provider-dialog';
import { canEditProvider, createProviderColumns } from './providers-table-columns';

interface ProvidersTableProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly focusProviderId?: string | undefined;
}

export const ProvidersTable: React.FC<ProvidersTableProps> = ({ providers, focusProviderId }) => {
  'use no memo';

  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const filterForm = useForm({ defaultValues: { providerFilter: '' } });
  const hasDetails = providers.some(
    (provider) =>
      provider.accountLabel !== undefined ||
      provider.plugin !== undefined ||
      provider.capability !== undefined ||
      provider.expiresAt !== undefined,
  );
  const columns = useMemo(() => createProviderColumns(deleteDialogRef, hasDetails), [hasDetails]);
  const { table } = useDataTable(providers, columns);

  useEffect(() => {
    if (focusProviderId === undefined) return;
    const rowIndex = table.getPrePaginationRowModel().rows.findIndex((row) => row.original.id === focusProviderId);
    if (rowIndex < 0) return;
    table.setPageIndex(Math.floor(rowIndex / table.getState().pagination.pageSize));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = document.getElementById(`provider-row-${focusProviderId}`);
        row?.scrollIntoView?.({ block: 'center' });
        (document.getElementById(`provider-link-${focusProviderId}`) ?? row)?.focus();
      });
    });
  }, [focusProviderId, table]);

  if (providers.length === 0) {
    return <Empty>{m['dashboard.providers.empty_state']()}</Empty>;
  }

  return (
    <div className="flex flex-col gap-4">
      <filterForm.Field name="providerFilter">
        {(field) => (
          <Field className="max-w-sm">
            <FieldLabel htmlFor="providers-table-filter" className="sr-only">
              {m['dashboard.providers.table.filter']()}
            </FieldLabel>
            <Input
              id="providers-table-filter"
              value={field.state.value}
              placeholder={m['dashboard.providers.table.filter_placeholder']()}
              onChange={(event) => {
                field.handleChange(event.target.value);
                table.setGlobalFilter(event.target.value);
              }}
            />
          </Field>
        )}
      </filterForm.Field>
      <Table aria-label={m['dashboard.providers.table.label']()} data-testid="providers-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <TableHead
                  key={header.id}
                  className={cn(
                    header.column.id === 'details' && 'hidden lg:table-cell',
                    header.column.id === 'models' && 'hidden w-20 text-right sm:table-cell',
                    header.column.id === 'actions' && 'w-8 px-1 sm:w-12 sm:px-3',
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
              data-focused={row.original.id === focusProviderId ? 'true' : undefined}
              className={cn(
                'relative',
                canEditProvider(row.original) &&
                  'cursor-pointer focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-ring/40',
                row.original.id === focusProviderId && 'bg-accent ring-2 ring-ring/40',
              )}
            >
              {row.getVisibleCells().map((cell) => (
                <TableCell
                  key={cell.id}
                  className={cn(
                    cell.column.id === 'details' && 'hidden lg:table-cell',
                    cell.column.id === 'models' && 'relative z-10 hidden w-20 text-right sm:table-cell',
                    cell.column.id === 'actions' && 'relative z-10 w-8 px-1 sm:w-12 sm:px-3',
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
