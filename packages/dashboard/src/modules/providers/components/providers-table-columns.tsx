import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Link } from '@tanstack/react-router';
import type { ColumnDef, HeaderContext } from '@tanstack/react-table';
import { startCase } from 'es-toolkit/string';
import type React from 'react';

import { DataTableHeaderCell } from '@/components/data-table-header-cell';

import { PROVIDER_KIND_LABEL } from '../constants';
import type { DeleteProviderDialogRef } from './delete-provider-dialog';
import { ProviderEnabledSwitch } from './provider-enabled-switch';
import { ProviderModelsCell } from './provider-models-cell';
import { ProviderMoreMenu } from './provider-more-menu';
import { ProviderStateCell } from './provider-state-cell';
import type { ProviderTableRow } from './providers-table/provider-table-row';

const uneditableDiagnosticCodes = new Set(['PROVIDER_CONFIG_INVALID', 'LEGACY_OAUTH_CONFIG_UNSUPPORTED']);

export const canEditProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind !== 'invalid' &&
  (provider.state.diagnostic === undefined || !uneditableDiagnosticCodes.has(provider.state.diagnostic.code));

const displayName = (provider: DashboardProviderSummary): string =>
  (provider.kind === 'oauth' ? (provider.accountLabel ?? provider.name) : provider.name) ?? startCase(provider.id);

const concreteProvider = (row: ProviderTableRow): DashboardProviderSummary | undefined =>
  row.rowType === 'provider' ? row.provider : undefined;

const withSortingHandler = (handler: ((event: unknown) => void) | undefined) =>
  handler === undefined ? {} : { onToggleSorting: handler };

const sortableHeader =
  (label: () => string) =>
  ({ column }: HeaderContext<ProviderTableRow, unknown>) => (
    <DataTableHeaderCell
      label={label()}
      canSort={column.getCanSort()}
      sortDirection={column.getIsSorted()}
      {...withSortingHandler(column.getToggleSortingHandler())}
    />
  );

export const providerColumnLabel = (columnId: string): string => {
  if (columnId === 'provider') return m['dashboard.providers.table.col_provider']();
  if (columnId === 'type') return m['dashboard.providers.table.col_type']();
  if (columnId === 'protocol') return m['dashboard.providers.table.col_protocol']();
  if (columnId === 'models') return m['dashboard.providers.table.col_models']();
  if (columnId === 'weight') return m['dashboard.providers.table.col_weight']();
  if (columnId === 'state') return m['dashboard.providers.table.col_state']();
  if (columnId === 'enabled') return m['dashboard.providers.table.col_enabled']();
  if (columnId === 'actions') return m['dashboard.providers.table.col_actions']();
  throw new Error(`Unknown Provider column: ${columnId}`);
};

const providerColumn: ColumnDef<ProviderTableRow> = {
  id: 'provider',
  accessorFn: (row) =>
    row.rowType === 'oauth-group'
      ? [row.groupKey, ...row.accounts.flatMap(({ provider }) => [displayName(provider), provider.id])].join(' ')
      : `${displayName(row.provider)} ${row.provider.id}`,
  header: sortableHeader(() => m['dashboard.providers.table.col_provider']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    const name = displayName(provider);
    return (
      <div className={row.depth === 0 ? 'min-w-40' : 'min-w-40 pl-7'}>
        {canEditProvider(provider) ? (
          <Link
            id={`provider-link-${provider.id}`}
            to="/providers/$id/edit"
            params={{ id: provider.id }}
            aria-label={m['dashboard.providers.actions.edit_provider']({ id: provider.id })}
            className="font-medium"
          >
            {name}
          </Link>
        ) : (
          <div className="font-medium">{name}</div>
        )}
        <div className="text-xs text-muted-foreground">{provider.id}</div>
      </div>
    );
  },
};

const typeColumn: ColumnDef<ProviderTableRow> = {
  id: 'type',
  accessorFn: (row) => {
    if (row.rowType === 'oauth-group') return `OAuth ${row.groupKey}`;
    return row.provider.kind === 'ai-sdk'
      ? (row.provider.packageName ?? PROVIDER_KIND_LABEL['ai-sdk'])
      : row.provider.kind === 'invalid'
        ? m['dashboard.providers.kind_label.invalid']()
        : PROVIDER_KIND_LABEL[row.provider.kind];
  },
  header: sortableHeader(() => m['dashboard.providers.table.col_type']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    if (provider.kind === 'ai-sdk') return provider.packageName ?? PROVIDER_KIND_LABEL['ai-sdk'];
    if (provider.kind === 'invalid') return m['dashboard.providers.kind_label.invalid']();
    return PROVIDER_KIND_LABEL[provider.kind];
  },
};

const protocolColumn: ColumnDef<ProviderTableRow> = {
  id: 'protocol',
  accessorFn: (row) => (row.rowType === 'provider' && row.provider.kind === 'api' ? (row.provider.protocol ?? '') : ''),
  header: sortableHeader(() => m['dashboard.providers.table.col_protocol']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider?.kind === 'api' ? (provider.protocol ?? 'N/A') : 'N/A';
  },
};

const modelsColumn: ColumnDef<ProviderTableRow> = {
  id: 'models',
  accessorFn: (row) =>
    row.rowType === 'oauth-group'
      ? row.accounts.flatMap(({ provider }) => provider.clientModels).join(' ')
      : row.provider.clientModels.join(' '),
  header: sortableHeader(() => m['dashboard.providers.table.col_models']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : <ProviderModelsCell models={provider.clientModels} />;
  },
};

const weightColumn: ColumnDef<ProviderTableRow> = {
  id: 'weight',
  accessorFn: (row) => concreteProvider(row)?.weight,
  header: sortableHeader(() => m['dashboard.providers.table.col_weight']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : (provider.weight ?? 'N/A');
  },
};

const stateColumn: ColumnDef<ProviderTableRow> = {
  id: 'state',
  accessorFn: (row) => {
    const provider = concreteProvider(row);
    return provider === undefined
      ? ''
      : `${provider.state.status} ${provider.state.diagnostic?.summary ?? ''} ${provider.state.diagnostic?.code ?? ''}`;
  },
  header: sortableHeader(() => m['dashboard.providers.table.col_state']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : <ProviderStateCell provider={provider} />;
  },
};

export const createProviderColumns = (
  deleteDialogRef: React.RefObject<DeleteProviderDialogRef | null>,
): ColumnDef<ProviderTableRow>[] => [
  providerColumn,
  typeColumn,
  protocolColumn,
  modelsColumn,
  weightColumn,
  stateColumn,
  {
    id: 'enabled',
    accessorFn: (row) => String(concreteProvider(row)?.enabled ?? ''),
    header: sortableHeader(() => m['dashboard.providers.table.col_enabled']()),
    cell: ({ row }) => {
      const provider = concreteProvider(row.original);
      return provider === undefined || !canEditProvider(provider) ? null : (
        <ProviderEnabledSwitch provider={provider} />
      );
    },
  },
  {
    id: 'actions',
    enableSorting: false,
    header: sortableHeader(() => m['dashboard.providers.table.col_actions']()),
    cell: ({ row }) => {
      const provider = concreteProvider(row.original);
      return provider === undefined || !canEditProvider(provider) ? null : (
        <ProviderMoreMenu provider={provider} onDelete={(target) => deleteDialogRef.current?.open(target)} />
      );
    },
  },
];
