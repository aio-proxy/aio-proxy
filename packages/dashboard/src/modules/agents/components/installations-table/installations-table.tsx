import { m } from '@aio-proxy/i18n';
import { Badge } from '@aio-proxy/ui/components/badge';
import { Empty } from '@aio-proxy/ui/components/empty';
import { Table, TableBody, TableCell, TableHeader, TableRow } from '@aio-proxy/ui/components/table';
import type { ColumnDef } from '@tanstack/react-table';
import { Fragment, useMemo } from 'react';

import { Pagination } from '@/components/data-table/pagination';
import { tableHead } from '@/components/data-table/table-head';
import { type DataTableFeatures, useDataTable } from '@/hooks/use-data-table';

import type { AgentInstallationRow } from '../../lib/agent-state';
import { RevokeInstallationButton } from '../revoke-installation-button';

interface InstallationsTableProps {
  readonly installations: readonly AgentInstallationRow[];
  /** Revoking is a write, so only a browser on the aio-proxy machine may do it. */
  readonly canRevoke: boolean;
  readonly emptyMessage: string;
}

const formatTime = (value: string | null): string => (value === null ? 'N/A' : new Date(value).toLocaleString());

const authorizationLabel = (status: AgentInstallationRow['authorization']): string => {
  if (status === 'active') return m['dashboard.agents.authorization.active']();
  if (status === 'expired') return m['dashboard.agents.authorization.expired']();
  return m['dashboard.agents.authorization.revoked']();
};

const createColumns = (canRevoke: boolean): ColumnDef<DataTableFeatures, AgentInstallationRow>[] => [
  {
    id: 'installationId',
    accessorKey: 'installationId',
    header: tableHead(() => m['dashboard.agents.table.installation']()),
    cell: ({ row }) => <span className="font-mono text-xs">{row.original.installationId}</span>,
  },
  {
    id: 'adapterVersion',
    accessorKey: 'adapterVersion',
    header: tableHead(() => m['dashboard.agents.table.adapter']()),
  },
  {
    id: 'lastAuthorizedAt',
    accessorKey: 'lastAuthorizedAt',
    header: tableHead(() => m['dashboard.agents.table.last_authorized']()),
    cell: ({ row }) => formatTime(row.original.lastAuthorizedAt),
  },
  {
    id: 'authorization',
    accessorKey: 'authorization',
    header: tableHead(() => m['dashboard.agents.table.status']()),
    cell: ({ row }) => (
      <Badge variant={row.original.authorization === 'active' ? 'secondary' : 'outline'}>
        {authorizationLabel(row.original.authorization)}
      </Badge>
    ),
  },
  {
    id: 'local',
    accessorFn: (row) => row.local ?? '',
    header: tableHead(() => m['dashboard.agents.table.local']()),
    cell: ({ row }) =>
      row.original.local === undefined
        ? 'N/A'
        : row.original.local === 'configured'
          ? m['dashboard.agents.local.configured']()
          : m['dashboard.agents.local.orphaned'](),
  },
  {
    id: 'actions',
    enableSorting: false,
    header: tableHead(() => m['dashboard.agents.table.actions']()),
    cell: ({ row }) =>
      row.original.authorization === 'revoked' ? null : (
        <RevokeInstallationButton installationId={row.original.installationId} disabled={!canRevoke} />
      ),
  },
];

export const InstallationsTable: React.FC<InstallationsTableProps> = ({ installations, canRevoke, emptyMessage }) => {
  'use no memo';

  const columns = useMemo(() => createColumns(canRevoke), [canRevoke]);
  const { table } = useDataTable(installations, columns, { getRowId: (row) => row.installationId });

  if (installations.length === 0) return <Empty>{emptyMessage}</Empty>;

  return (
    <div className="flex flex-col gap-4">
      <Table aria-label={m['dashboard.agents.table.label']()} data-testid="agent-installations-table">
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
            <TableRow key={row.id}>
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
    </div>
  );
};
