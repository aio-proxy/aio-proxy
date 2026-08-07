import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@aio-proxy/ui/components/dropdown-menu';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Field, FieldLabel } from '@aio-proxy/ui/components/field';
import { Input } from '@aio-proxy/ui/components/input';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useForm } from '@tanstack/react-form';
import { flexRender } from '@tanstack/react-table';
import type React from 'react';
import { Fragment, useEffect, useMemo, useRef } from 'react';

import { PaginationControls } from '@/components/pagination-controls';
import { useDataTable } from '@/hooks/use-data-table';

import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../delete-provider-dialog';
import { OAuthProviderGroupRow } from '../oauth-provider-group-row';
import { canEditProvider, createProviderColumns, providerColumnLabel } from '../providers-table-columns';
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
  const rows = useMemo(() => groupProviderRows(providers), [providers]);
  const columns = useMemo(() => createProviderColumns(deleteDialogRef), []);
  const { table, columnVisibilityForm } = useDataTable(rows, columns, {
    getRowId: providerTableRowId,
    getSubRows: (row) => (row.rowType === 'oauth-group' ? row.accounts : undefined),
  });
  const filterForm = useForm({ defaultValues: { tableFilter: '' } });

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
      <div className="flex flex-wrap items-end justify-between gap-2">
        <filterForm.Field name="tableFilter">
          {(field) => (
            <Field className="max-w-xs">
              <FieldLabel htmlFor="providers-table-filter">{m['dashboard.providers.table.filter']()}</FieldLabel>
              <Input
                id="providers-table-filter"
                value={field.state.value}
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
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" />}>
            {m['dashboard.providers.table.columns']()}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <columnVisibilityForm.Field name="columnVisibility">
              {(field) =>
                table.getAllLeafColumns().map((column) => (
                  <DropdownMenuCheckboxItem
                    key={column.id}
                    checked={field.state.value[column.id] !== false}
                    onCheckedChange={(checked) => field.handleChange({ ...field.state.value, [column.id]: checked })}
                  >
                    {providerColumnLabel(column.id)}
                  </DropdownMenuCheckboxItem>
                ))
              }
            </columnVisibilityForm.Field>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Table aria-label={m['dashboard.providers.table.label']()} data-testid="providers-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <Fragment key={header.id}>
                  {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                </Fragment>
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
      {table.getPageCount() > 1 ? (
        <PaginationControls
          pageSize={table.getState().pagination.pageSize}
          canPrevious={table.getCanPreviousPage()}
          canNext={table.getCanNextPage()}
          onShowSizeChange={table.setPageSize}
          onPrevious={table.previousPage}
          onNext={table.nextPage}
        />
      ) : null}
      <DeleteProviderDialog ref={deleteDialogRef} />
    </div>
  );
};
