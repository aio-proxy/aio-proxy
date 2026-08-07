import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { cn } from '@aio-proxy/ui/lib/utils';
import type React from 'react';
import { Fragment, useEffect, useMemo, useRef } from 'react';

import { Pagination } from '@/components/data-table/pagination';
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

export const ProvidersTable: React.FC<ProvidersTableProps> = ({ providers, focusProviderId }) => {
  'use no memo';

  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
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
    if (root?.rowType === 'oauth-group') {
      const tableRow = table.getRow(providerTableRowId(root));
      if (!tableRow.getIsExpanded()) tableRow.toggleExpanded(true);
    }
    const pageIndex = Math.floor(rootIndex / table.state.pagination.pageSize);
    if (table.state.pagination.pageIndex !== pageIndex) table.setPageIndex(pageIndex);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const row = document.getElementById(`provider-row-${focusProviderId}`);
        row?.scrollIntoView?.({ block: 'center' });
        (document.getElementById(`provider-link-${focusProviderId}`) ?? row)?.focus();
      });
    });
  }, [focusProviderId, rows]);

  if (providers.length === 0) {
    return <Empty>{m['dashboard.providers.empty_state']()}</Empty>;
  }

  return (
    <div className="flex flex-col gap-4">
      <Table aria-label={m['dashboard.providers.table.label']()} data-testid="providers-table">
        <TableHeader>
          {table.getHeaderGroups().map((headerGroup) => (
            <TableRow key={headerGroup.id}>
              {headerGroup.headers.map((header) => (
                <Fragment key={header.id}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </Fragment>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {table.getRowModel().rows.map((row) => {
            if (row.original.rowType === 'oauth-group') {
              return <OAuthProviderGroupRow key={row.id} row={row} columnCount={row.getAllCells().length} />;
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
                {row.getAllCells().map((cell) => (
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
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {table.getPageCount() > 1 ? (
        <Pagination
          pageSize={table.state.pagination.pageSize}
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
