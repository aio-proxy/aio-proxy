import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Button } from '@aio-proxy/ui/components/button';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef } from '@tanstack/react-table';
import type React from 'react';
import { Fragment, useMemo, useRef } from 'react';

import { Pagination } from '@/components/data-table/pagination';
import { tableHead } from '@/components/data-table/table-head';
import { type DataTableFeatures, useDataTable } from '@/hooks/use-data-table';
import { resolveDashboardText } from '@/lib/localized-text';

import { PluginOptionsDrawer, type PluginOptionsDrawerRef } from './plugin-options-drawer';
import { PluginUninstallDialog, type PluginUninstallDialogRef } from './plugin-uninstall-dialog';

interface PluginsTableProps {
  readonly plugins: readonly DashboardPluginSummary[];
}

const createPluginColumns = (
  optionsRef: React.RefObject<PluginOptionsDrawerRef | null>,
  uninstallRef: React.RefObject<PluginUninstallDialogRef | null>,
): ColumnDef<DataTableFeatures, DashboardPluginSummary>[] => [
  {
    id: 'packageName',
    accessorKey: 'packageName',
    header: tableHead(() => m['dashboard.plugins.table_package']()),
    cell: ({ row }) => (
      <div className="min-w-52">
        {row.original.displayName === undefined ? null : (
          <div className="font-medium">{resolveDashboardText(row.original.displayName)}</div>
        )}
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs">{row.original.packageName}</span>
          {row.original.builtin ? <Badge variant="outline">{m['dashboard.plugins.builtin']()}</Badge> : null}
        </div>
      </div>
    ),
  },
  {
    id: 'version',
    accessorFn: (plugin) => plugin.version ?? '',
    header: tableHead(() => m['dashboard.plugins.table_version']()),
    cell: ({ row }) => row.original.version ?? 'N/A',
  },
  {
    id: 'status',
    accessorFn: (plugin) => plugin.state.status,
    header: tableHead(() => m['dashboard.plugins.table_status']()),
    cell: ({ row }) => (
      <div className="space-y-1">
        <Badge variant={row.original.state.status === 'failed' ? 'destructive' : 'outline'}>
          {row.original.state.status === 'failed'
            ? m['dashboard.plugins.status_failed']()
            : m['dashboard.plugins.status_ready']()}
        </Badge>
        {row.original.state.status === 'failed' ? (
          <p className="max-w-72 text-xs text-muted-foreground">{row.original.state.diagnostic.summary}</p>
        ) : null}
      </div>
    ),
  },
  {
    id: 'enabled',
    accessorFn: (plugin) => String(plugin.enabled),
    header: tableHead(() => m['dashboard.plugins.table_enabled']()),
    cell: ({ row }) => (
      <Badge variant="secondary">
        {row.original.enabled ? m['dashboard.plugins.enabled']() : m['dashboard.plugins.disabled']()}
      </Badge>
    ),
  },
  {
    id: 'actions',
    enableSorting: false,
    header: tableHead(() => m['dashboard.plugins.table_actions']()),
    cell: ({ row }) => (
      <div className="flex justify-end gap-2">
        {row.original.hasOptions ? (
          <Button type="button" size="sm" variant="outline" onClick={() => optionsRef.current?.open(row.original)}>
            {m['dashboard.plugins.options_action']()}
          </Button>
        ) : null}
        {row.original.builtin ? null : (
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={() => uninstallRef.current?.open(row.original)}
          >
            {m['dashboard.plugins.uninstall_action']()}
          </Button>
        )}
      </div>
    ),
  },
];

export const PluginsTable: React.FC<PluginsTableProps> = ({ plugins }) => {
  'use no memo';

  const optionsRef = useRef<PluginOptionsDrawerRef>(null);
  const uninstallRef = useRef<PluginUninstallDialogRef>(null);
  const columns = useMemo(() => createPluginColumns(optionsRef, uninstallRef), []);
  const { table } = useDataTable(plugins, columns, { getRowId: (plugin) => plugin.packageName });

  if (plugins.length === 0) return <Empty>{m['dashboard.plugins.empty']()}</Empty>;

  return (
    <div className="flex flex-col gap-4">
      <Table aria-label={m['dashboard.plugins.table_label']()} data-testid="plugins-table">
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
          {table.getRowModel().rows.map((row) => (
            <TableRow key={row.id} data-testid={`plugin-row-${row.original.packageName}`}>
              {row.getAllCells().map((cell) => (
                <TableCell key={cell.id} className={cell.column.id === 'actions' ? 'text-right' : undefined}>
                  <table.FlexRender cell={cell} />
                </TableCell>
              ))}
            </TableRow>
          ))}
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
      <PluginOptionsDrawer ref={optionsRef} />
      <PluginUninstallDialog ref={uninstallRef} />
    </div>
  );
};
