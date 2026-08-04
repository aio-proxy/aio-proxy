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

import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../delete-provider-dialog';
import { OAuthProviderGroupRow } from '../oauth-provider-group-row';
import { canEditProvider, createProviderColumns } from '../providers-table-columns';
import { groupProviderRows, providerTableRowId, type ProviderTableRow } from './provider-table-row';

interface ProvidersTableProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly focusProviderId?: string | undefined;
}

const providerIdInRow = (row: ProviderTableRow, providerId: string): boolean =>
  row.rowType === 'provider'
    ? row.provider.id === providerId
    : row.accounts.some(({ provider }) => provider.id === providerId);

const providerMatchesFilter = (provider: DashboardProviderSummary, filter: string): boolean => {
  const query = filter.trim().toLowerCase();
  return (
    query !== '' &&
    [provider.id, provider.name, provider.accountLabel].some((value) => value?.toLowerCase().includes(query) === true)
  );
};

export const ProvidersTable: React.FC<ProvidersTableProps> = ({ providers, focusProviderId }) => {
  'use no memo';

  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const filterForm = useForm({ defaultValues: { providerFilter: '' } });
  const rows = useMemo(() => groupProviderRows(providers), [providers]);
  const columns = useMemo(() => createProviderColumns(deleteDialogRef), []);
  const { table } = useDataTable(rows, columns, {
    getRowId: providerTableRowId,
    getSubRows: (row) => (row.rowType === 'oauth-group' ? row.accounts : undefined),
  });

  useEffect(() => {
    if (focusProviderId === undefined) return;
    const rootIndex = rows.findIndex((row) => providerIdInRow(row, focusProviderId));
    if (rootIndex < 0) return;
    const root = rows[rootIndex];
    if (root?.rowType === 'oauth-group') table.getRow(providerTableRowId(root)).toggleExpanded(true);
    table.setPageIndex(Math.floor(rootIndex / table.getState().pagination.pageSize));
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = document.getElementById(`provider-row-${focusProviderId}`);
        row?.scrollIntoView?.({ block: 'center' });
        (document.getElementById(`provider-link-${focusProviderId}`) ?? row)?.focus();
      });
    });
  }, [focusProviderId, rows, table]);

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
                const filter = event.target.value;
                field.handleChange(filter);
                table.setGlobalFilter(filter);
                for (const row of rows) {
                  if (
                    row.rowType === 'oauth-group' &&
                    row.accounts.some(({ provider }) => providerMatchesFilter(provider, filter))
                  ) {
                    table.getRow(providerTableRowId(row)).toggleExpanded(true);
                  }
                }
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
                    header.column.id === 'models' && 'w-20 text-right',
                    header.column.id === 'weight' && 'w-20 text-right',
                    header.column.id === 'enabled' && 'w-20 text-center',
                    header.column.id === 'actions' && 'w-20 text-right',
                  )}
                >
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            if (row.original.rowType === 'oauth-group') {
              return <OAuthProviderGroupRow key={row.id} row={row} columnCount={row.getVisibleCells().length} />;
            }
            const provider = row.original.provider;
            return (
              <TableRow
                key={row.id}
                id={`provider-row-${provider.id}`}
                tabIndex={-1}
                data-testid={`provider-row-${provider.id}`}
                data-focused={provider.id === focusProviderId ? 'true' : undefined}
                className={cn(
                  canEditProvider(provider) && 'focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-ring/40',
                  provider.id === focusProviderId && 'bg-accent ring-2 ring-ring/40',
                )}
              >
                {row.getVisibleCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={cn(
                      cell.column.id === 'models' && 'w-20 text-right',
                      cell.column.id === 'weight' && 'w-20 text-right',
                      cell.column.id === 'state' && 'whitespace-normal',
                      cell.column.id === 'enabled' && 'w-20 text-center',
                      cell.column.id === 'actions' && 'w-20 text-right',
                    )}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {table.getPageCount() > 1 ? <DataTablePagination table={table} /> : null}
      <DeleteProviderDialog ref={deleteDialogRef} />
    </div>
  );
};
