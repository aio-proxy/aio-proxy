import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { startCase } from 'es-toolkit/string';

import { tableHead } from '@/components/data-table/table-head';
import { ProtocolLabel } from '@/components/protocol-label';
import { formatCompactTokenCount } from '@/components/token-count';
import type { DataTableFeatures } from '@/hooks/use-data-table';

import { PROVIDER_KIND_LABEL } from '../lib/constants';
import type { ProviderUsage } from '../services/provider-usage-service';
import { ProviderEnabledSwitch } from './provider-enabled-switch';
import { ProviderModelsCell } from './provider-models-cell';
import { ProviderStateCell } from './provider-state-cell';
import { ProviderTableActions } from './provider-table-actions';
import type { ProviderTableRow } from './providers-table/provider-table-row';

export type ProviderUsageStatus = 'loading' | 'ready' | 'unavailable';

export const formatProviderUsage = (status: ProviderUsageStatus, requests: bigint): string => {
  if (status === 'loading') return '…';
  if (status === 'unavailable') return 'N/A';
  return formatCompactTokenCount(requests);
};

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
  enableHiding: false,
  enableSorting: false,
  meta: { label: () => m['dashboard.providers.table.col_provider']() },
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
  meta: { className: 'w-36 max-w-36 whitespace-normal', label: () => m['dashboard.providers.table.col_type']() },
  accessorFn: (row) => {
    if (row.rowType === 'oauth-group') return `OAuth ${row.groupKey}`;
    if (row.provider.kind === 'api') return `${PROVIDER_KIND_LABEL.api} · ${row.provider.protocols[0] ?? 'N/A'}`;
    if (row.provider.kind === 'ai-sdk') return row.provider.packageName ?? PROVIDER_KIND_LABEL['ai-sdk'];
    if (row.provider.kind === 'invalid') return m['dashboard.providers.kind_label.invalid']();
    return PROVIDER_KIND_LABEL[row.provider.kind];
  },
  header: tableHead(() => m['dashboard.providers.table.col_type']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    if (provider.kind === 'api') {
      return (
        <div className="leading-5">
          <div className="">{PROVIDER_KIND_LABEL.api}</div>
          <ProtocolLabel className="truncate text-muted-foreground" protocol={provider.protocols[0] ?? 'N/A'} />
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
  meta: { className: 'w-20 text-center', label: () => m['dashboard.providers.table.col_models']() },
  accessorFn: (row) =>
    row.rowType === 'oauth-group'
      ? row.accounts.flatMap(({ provider }) => provider.clientModels).join(' ')
      : row.provider.clientModels.join(' '),
  header: tableHead(() => m['dashboard.providers.table.col_models']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : <ProviderModelsCell models={provider.clientModels} />;
  },
};

const numericRoutingColumn = (
  id: 'priority' | 'weight',
  label: () => string,
  fallback: number,
): ColumnDef<DataTableFeatures, ProviderTableRow> => ({
  id,
  meta: { className: 'w-20 text-center', label },
  accessorFn: (row) => concreteProvider(row)?.[id] ?? fallback,
  header: tableHead(label),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined ? null : (provider[id] ?? fallback);
  },
});

const priorityColumn = numericRoutingColumn('priority', () => m['dashboard.providers.table.col_priority'](), 0);
const weightColumn = numericRoutingColumn('weight', () => m['dashboard.providers.table.col_weight'](), 1);

const stateColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'state',
  enableSorting: false,
  meta: { className: 'whitespace-normal', label: () => m['dashboard.providers.table.col_state']() },
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
  enableHiding: false,
  enableSorting: false,
  meta: { className: 'w-12' },
  header: tableHead(() => ''),
  cell: () => null,
};

const enabledColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'enabled',
  meta: { className: 'w-20 text-center', label: () => m['dashboard.providers.table.col_enabled']() },
  accessorFn: (row) => String(concreteProvider(row)?.enabled ?? ''),
  header: tableHead(() => m['dashboard.providers.table.col_enabled']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined || !canEditProvider(provider) ? null : <ProviderEnabledSwitch provider={provider} />;
  },
};

const usageColumn = (
  providerUsage: ReadonlyMap<string, ProviderUsage>,
  providerUsageStatus: ProviderUsageStatus,
): ColumnDef<DataTableFeatures, ProviderTableRow> => ({
  id: 'usage',
  meta: { className: 'w-24 text-right', label: () => m['dashboard.providers.table.col_usage_24h']() },
  accessorFn: (row) => requestCount(row, providerUsage),
  header: tableHead(() => m['dashboard.providers.table.col_usage_24h']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    if (provider === undefined) return null;
    return (
      <span className="tabular-nums">
        {formatProviderUsage(providerUsageStatus, providerUsage.get(provider.id)?.requestCount ?? 0n)}
      </span>
    );
  },
});

const actionsColumn: ColumnDef<DataTableFeatures, ProviderTableRow> = {
  id: 'actions',
  enableSorting: false,
  meta: { className: 'w-20 text-right', label: () => m['dashboard.providers.table.col_actions']() },
  header: tableHead(() => m['dashboard.providers.table.col_actions']()),
  cell: ({ row }) => {
    const provider = concreteProvider(row.original);
    return provider === undefined || !canEditProvider(provider) ? null : <ProviderTableActions provider={provider} />;
  },
};

export const createProviderColumns = (
  providerUsage: ReadonlyMap<string, ProviderUsage>,
  providerUsageStatus: ProviderUsageStatus,
): ColumnDef<DataTableFeatures, ProviderTableRow>[] => [
  aggregateColumn,
  providerColumn,
  typeColumn,
  modelsColumn,
  priorityColumn,
  weightColumn,
  stateColumn,
  usageColumn(providerUsage, providerUsageStatus),
  enabledColumn,
  actionsColumn,
];
