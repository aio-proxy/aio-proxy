import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { startCase } from 'es-toolkit/string';
import type React from 'react';

import { tableHead } from '@/components/data-table/table-head';
import { ProtocolLabel } from '@/components/protocol-label';
import { formatCompactTokenCount } from '@/components/token-count';
import type { DataTableFeatures } from '@/hooks/use-data-table';

import { PROVIDER_KIND_LABEL } from '../lib/constants';
import type { ProviderUsage } from '../services/provider-usage-service';
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

const requestCount = (row: ProviderTableRow, providerUsage: ReadonlyMap<string, ProviderUsage>): bigint =>
  (row.rowType === 'provider' ? [row.provider] : row.accounts.map(({ provider }) => provider)).reduce(
    (total, provider) => total + (providerUsage.get(provider.id)?.requestCount ?? 0n),
    0n,
  );

const providerColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'provider',
  enableSorting: false,
  accessorFn: (row) =>
    row.rowType === 'oauth-group'
      ? [row.groupKey, ...row.accounts.flatMap(({ provider }) => [displayName(provider), provider.id])].join(' ')
      : `${displayName(row.provider)} ${row.provider.id}`,
  header: tableHead(() => m['dashboard.providers.table.col_provider']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    const name = displayName(provider);
    return (
      <div className="max-w-64 min-w-16 truncate">
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
        <div className="truncate text-muted-foreground">{provider.id}</div>
      </div>
    );
  },
};

const typeColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'type',
  enableSorting: false,
  accessorFn: (row) => {
    if (row.rowType === 'oauth-group') return `OAuth ${row.groupKey}`;
    return row.provider.kind === 'api'
      ? `${PROVIDER_KIND_LABEL.api} · ${row.provider.protocol ?? 'N/A'}`
      : row.provider.kind === 'ai-sdk'
        ? (row.provider.packageName ?? PROVIDER_KIND_LABEL['ai-sdk'])
        : row.provider.kind === 'invalid'
          ? m['dashboard.providers.kind_label.invalid']()
          : PROVIDER_KIND_LABEL[row.provider.kind];
  },
  header: tableHead(() => m['dashboard.providers.table.col_type'](), 'w-36'),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    if (provider.kind === 'api') {
      return (
        <div className="leading-5">
          <div className="">{PROVIDER_KIND_LABEL.api}</div>
          <ProtocolLabel className="truncate text-muted-foreground" protocol={provider.protocol ?? 'N/A'} />
        </div>
      );
    }
    if (provider.kind === 'ai-sdk') {
      return <span className="block truncate">{provider.packageName ?? PROVIDER_KIND_LABEL['ai-sdk']}</span>;
    }
    if (provider.kind === 'invalid') return m['dashboard.providers.kind_label.invalid']();
    return PROVIDER_KIND_LABEL[provider.kind];
  },
};

const modelsColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'models',
  enableSorting: false,
  accessorFn: (row) =>
    row.rowType === 'oauth-group'
      ? row.accounts.flatMap(({ provider }) => provider.clientModels).join(' ')
      : row.provider.clientModels.join(' '),
  header: tableHead(() => m['dashboard.providers.table.col_models'](), 'text-center'),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : <ProviderModelsCell models={provider.clientModels} />;
  },
};

const weightColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'weight',
  accessorFn: (row) => concreteProvider(row)?.weight,
  header: tableHead(() => m['dashboard.providers.table.col_weight'](), 'text-center'),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : (provider.weight ?? 0);
  },
};

const stateColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'state',
  enableSorting: false,
  accessorFn: (row) => {
    const provider = concreteProvider(row);
    return provider === undefined
      ? ''
      : `${provider.state.status} ${provider.state.diagnostic?.summary ?? ''} ${provider.state.diagnostic?.code ?? ''}`;
  },
  header: tableHead(() => m['dashboard.providers.table.col_state']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : <ProviderStateCell provider={provider} />;
  },
};

const aggregateColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'aggregate',
  enableSorting: false,
  header: tableHead(() => ''),
  cell: () => null,
};

const enabledColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'enabled',
  accessorFn: (row) => String(concreteProvider(row)?.enabled ?? ''),
  header: tableHead(() => m['dashboard.providers.table.col_enabled'](), 'text-center'),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined || !canEditProvider(provider) ? null : <ProviderEnabledSwitch provider={provider} />;
  },
};

const usageColumn = (
  providerUsage: ReadonlyMap<string, ProviderUsage>,
): ColumnDef<DataTableFeatures, ProviderTableRow> => ({
  id: 'usage',
  accessorFn: (row) => requestCount(row, providerUsage),
  header: tableHead(() => m['dashboard.providers.table.col_usage_24h']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    return (
      <span className="tabular-nums">
        {formatCompactTokenCount(providerUsage.get(provider.id)?.requestCount ?? 0n)}
      </span>
    );
  },
});

const actionsColumn = (
  deleteDialogRef: React.RefObject<DeleteProviderDialogRef | null>,
): ColumnDef<DataTableFeatures, ProviderTableRow> => ({
  id: 'actions',
  enableSorting: false,
  header: tableHead(() => m['dashboard.providers.table.col_actions'](), 'text-right'),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined || !canEditProvider(provider) ? null : (
      <ProviderMoreMenu provider={provider} onDelete={(target) => deleteDialogRef.current?.open(target)} />
    );
  },
});

export const createProviderColumns = (
  deleteDialogRef: React.RefObject<DeleteProviderDialogRef | null>,
  providerUsage: ReadonlyMap<string, ProviderUsage>,
): ColumnDef<DataTableFeatures, ProviderTableRow>[] => [
  aggregateColumn,
  providerColumn,
  typeColumn,
  modelsColumn,
  weightColumn,
  stateColumn,
  usageColumn(providerUsage),
  enabledColumn,
  actionsColumn(deleteDialogRef),
];
