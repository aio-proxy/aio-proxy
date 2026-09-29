import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import type { ColumnDef } from '@tanstack/react-table';
import type React from 'react';
import { useMemo, useRef, useState } from 'react';

import { DataTableControls } from '@/components/data-table/data-table-controls';
import { Pagination } from '@/components/data-table/pagination';
import { type DataTableFeatures, useDataTable } from '@/hooks/use-data-table';
import { resolveDashboardText } from '@/lib/localized-text';

import { PluginCard } from '../plugin-card';
import { PluginFailedAlert } from '../plugin-failed-alert';
import { PluginOptionsDrawer, type PluginOptionsDrawerRef } from '../plugin-options-drawer';
import { PluginStatusFilter, type PluginStatusFilterValue } from '../plugin-status-filter';
import { PluginUninstallDialog, type PluginUninstallDialogRef } from '../plugin-uninstall-dialog';

interface PluginsGridProps {
  readonly plugins: readonly DashboardPluginSummary[];
}

const isFailed = (plugin: DashboardPluginSummary) => plugin.state.status === 'failed';

const STATUS_PREDICATES: Record<PluginStatusFilterValue, (plugin: DashboardPluginSummary) => boolean> = {
  all: () => true,
  enabled: (plugin) => plugin.enabled,
  failed: isFailed,
  builtin: (plugin) => plugin.builtin,
};

// The grid renders cards, but search and pagination stay on TanStack Table's row models.
const searchColumns: ColumnDef<DataTableFeatures, DashboardPluginSummary>[] = [
  { id: 'packageName', accessorKey: 'packageName' },
  {
    id: 'displayName',
    accessorFn: (plugin) => (plugin.displayName === undefined ? '' : resolveDashboardText(plugin.displayName)),
  },
];

export const PluginsGrid: React.FC<PluginsGridProps> = ({ plugins }) => {
  'use no memo';

  const optionsRef = useRef<PluginOptionsDrawerRef>(null);
  const uninstallRef = useRef<PluginUninstallDialogRef>(null);
  const [status, setStatus] = useState<PluginStatusFilterValue>('all');
  // The search input keeps its own draft, so remounting it is how the grid clears the text it shows.
  const [searchKey, setSearchKey] = useState(0);
  const failedCount = plugins.filter(isFailed).length;
  const visible = useMemo(() => plugins.filter(STATUS_PREDICATES[status]), [plugins, status]);
  const { table } = useDataTable(visible, searchColumns, { getRowId: (plugin) => plugin.packageName });

  if (plugins.length === 0) return <Empty>{m['dashboard.plugins.empty']()}</Empty>;

  const rows = table.getRowModel().rows;

  return (
    <div className="flex flex-col gap-4">
      {failedCount > 0 && status !== 'failed' ? (
        <PluginFailedAlert
          count={failedCount}
          onView={() => {
            setStatus('failed');
            table.setGlobalFilter('');
            setSearchKey((key) => key + 1);
          }}
        />
      ) : null}
      <DataTableControls
        key={searchKey}
        table={table}
        filterLabel={m['dashboard.plugins.filter_label']()}
        filterPlaceholder={m['dashboard.plugins.filter_placeholder']()}
      >
        <PluginStatusFilter value={status} failedCount={failedCount} onChange={setStatus} />
      </DataTableControls>
      {rows.length === 0 ? (
        <Empty>{m['dashboard.plugins.no_match']()}</Empty>
      ) : (
        <ul aria-label={m['dashboard.plugins.table_label']()} className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {rows.map((row) => (
            <li key={row.id} className="min-w-0">
              <PluginCard
                plugin={row.original}
                onOptions={(plugin) => optionsRef.current?.open(plugin)}
                onUninstall={(plugin) => uninstallRef.current?.open(plugin)}
              />
            </li>
          ))}
        </ul>
      )}
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
