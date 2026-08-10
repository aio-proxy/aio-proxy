import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Table, TableBody, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import { cn } from '@aio-proxy/ui/lib/utils';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { Fragment, useEffect, useMemo, useRef } from 'react';

import { DataTableControls } from '@/components/data-table/data-table-controls';
import { Pagination } from '@/components/data-table/pagination';
import { useDataTable } from '@/hooks/use-data-table';

import { providerPluginPresentationsQueryOptions } from '../../services/provider-plugin-labels';
import { providerUsageQueryOptions, type ProviderUsage } from '../../services/provider-usage-service';
import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../delete-provider-dialog';
import { OAuthProviderGroupRow } from '../oauth-provider-group-row';
import { ProviderTableActionsContext } from '../provider-table-actions';
import { canEditProvider, createProviderColumns, type ProviderUsageStatus } from '../providers-table-columns';
import { ProviderTableCell } from './provider-table-cell';
import { groupProviderRows, providerTableRowId, type ProviderTableRow } from './provider-table-row';

interface ProvidersTableProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly focusProviderId?: string | undefined;
}

const providerIdInRow = (row: ProviderTableRow, providerId: string): boolean =>
  row.rowType === 'provider'
    ? row.provider.id === providerId
    : row.accounts.some(({ provider }) => provider.id === providerId);

const emptyProviderUsage = new Map<string, ProviderUsage>();

export const ProvidersTable: React.FC<ProvidersTableProps> = ({ providers, focusProviderId }) => {
  'use no memo';

  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const plugins = useQuery(providerPluginPresentationsQueryOptions()).data?.plugins ?? [];
  const pluginPresentations = useMemo(() => new Map(plugins.map((plugin) => [plugin.packageName, plugin])), [plugins]);
  const providerUsageQuery = useQuery(providerUsageQueryOptions());
  const providerUsage = providerUsageQuery.data ?? emptyProviderUsage;
  let providerUsageStatus: ProviderUsageStatus;
  if (providerUsageQuery.isError) providerUsageStatus = 'unavailable';
  else if (providerUsageQuery.data === undefined) providerUsageStatus = 'loading';
  else providerUsageStatus = 'ready';
  const rows = useMemo(() => groupProviderRows(providers), [providers]);
  const columns = useMemo(
    () => createProviderColumns(providerUsage, providerUsageStatus),
    [providerUsage, providerUsageStatus],
  );
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
    <ProviderTableActionsContext.Provider value={{ deleteDialogRef }}>
      <div className="flex flex-col gap-4">
        <DataTableControls
          table={table}
          filterLabel={m['dashboard.providers.table.filter']()}
          filterPlaceholder={m['dashboard.providers.table.filter_placeholder']()}
          columnsLabel={m['dashboard.providers.table.columns']()}
        />
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
                return (
                  <OAuthProviderGroupRow
                    key={row.id}
                    pluginPresentations={pluginPresentations}
                    row={row}
                    providerUsage={providerUsage}
                    providerUsageStatus={providerUsageStatus}
                  />
                );
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
                    canEditProvider(provider) &&
                      'focus-within:bg-muted/50 focus-within:ring-2 focus-within:ring-ring/40',
                    provider.id === focusProviderId && 'bg-accent ring-2 ring-ring/40',
                  )}
                >
                  {row.getVisibleCells().map((cell) => (
                    <ProviderTableCell key={cell.id} cell={cell}>
                      <table.FlexRender cell={cell} />
                    </ProviderTableCell>
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
    </ProviderTableActionsContext.Provider>
  );
};
