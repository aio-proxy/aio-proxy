import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Link } from '@tanstack/react-router';
import type { ColumnDef } from '@tanstack/react-table';
import { startCase } from 'es-toolkit/string';
import { ChevronRight, Trash2 } from 'lucide-react';
import type React from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import type { DeleteProviderDialogRef } from './delete-provider-dialog';
import { ProviderModelsCell } from './provider-models-cell';
import { ProviderStateCell } from './provider-state-cell';

const kindLabels: Record<DashboardProviderSummary['kind'], () => string> = {
  api: () => m['dashboard.providers.kind_label.api'](),
  'ai-sdk': () => m['dashboard.providers.kind_label.ai-sdk'](),
  oauth: () => m['dashboard.providers.kind_label.oauth'](),
  invalid: () => m['dashboard.providers.kind_label.invalid'](),
};

const uneditableDiagnosticCodes = new Set(['PROVIDER_CONFIG_INVALID', 'LEGACY_OAUTH_CONFIG_UNSUPPORTED']);

export const canEditProvider = (provider: DashboardProviderSummary): boolean =>
  provider.kind !== 'invalid' &&
  (provider.state.diagnostic === undefined || !uneditableDiagnosticCodes.has(provider.state.diagnostic.code));

const displayName = (provider: DashboardProviderSummary): string => provider.name ?? startCase(provider.id);

const providerColumn: ColumnDef<DashboardProviderSummary> = {
  id: 'provider',
  accessorFn: (provider) => [displayName(provider), provider.id, kindLabels[provider.kind]()].join(' '),
  header: () => m['dashboard.providers.table.col_provider'](),
  cell: ({ row }) => {
    const provider = row.original;
    const name = displayName(provider);
    return (
      <div className="min-w-0 sm:min-w-40">
        {canEditProvider(provider) ? (
          <Link
            id={`provider-link-${provider.id}`}
            to="/providers/$id/edit"
            params={{ id: provider.id }}
            aria-label={m['dashboard.providers.actions.edit_provider']({ id: provider.id })}
            className="font-medium after:absolute after:inset-0 focus-visible:outline-none"
          >
            {name}
          </Link>
        ) : (
          <div className="font-medium">{name}</div>
        )}
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <span>{provider.id}</span>
          <span aria-hidden="true">·</span>
          <span>{kindLabels[provider.kind]()}</span>
          <span className="sm:hidden" aria-hidden="true">
            ·
          </span>
          <span className="sm:hidden" data-testid={`provider-mobile-models-${provider.id}`}>
            {(provider.clientModels ?? []).length} {m['dashboard.providers.table.col_models']()}
          </span>
        </div>
      </div>
    );
  },
};

const statusColumn: ColumnDef<DashboardProviderSummary> = {
  id: 'status',
  accessorFn: (provider) =>
    `${provider.enabled} ${provider.state.status} ${provider.state.status === 'ready' ? (provider.state.catalog ?? '') : ''}`,
  header: () => m['dashboard.providers.table.col_status'](),
  cell: ({ row }) => (
    <div className="flex min-w-0 flex-col items-start gap-1 sm:min-w-32 sm:flex-row sm:gap-2">
      <Badge variant={row.original.enabled ? 'secondary' : 'outline'}>
        {row.original.enabled ? m['dashboard.providers.badge.enabled']() : m['dashboard.providers.badge.disabled']()}
      </Badge>
      <div className="space-y-1 whitespace-normal">
        <ProviderStateCell provider={row.original} />
        {row.original.catalogLastSuccessAt === undefined ? null : (
          <div className="text-xs text-muted-foreground">
            {m['dashboard.providers.catalog.last_success_at']({
              value: new Date(row.original.catalogLastSuccessAt).toLocaleString(),
            })}
          </div>
        )}
      </div>
    </div>
  ),
};

const detailsColumn: ColumnDef<DashboardProviderSummary> = {
  id: 'details',
  accessorFn: (provider) => [provider.accountLabel, provider.plugin, provider.capability].filter(Boolean).join(' '),
  header: () => m['dashboard.providers.table.col_details'](),
  cell: ({ row }) => {
    const provider = row.original;
    const capability = [provider.plugin, provider.capability].filter(Boolean).join('/');
    if (provider.accountLabel === undefined && capability === '' && provider.expiresAt === undefined) {
      return null;
    }
    return (
      <div className="max-w-xs space-y-1 whitespace-normal">
        {provider.accountLabel === undefined ? null : <div>{provider.accountLabel}</div>}
        {capability === '' ? null : <div className="text-xs text-muted-foreground">{capability}</div>}
        {provider.expiresAt === undefined ? null : (
          <div className="text-xs text-muted-foreground">
            {m['dashboard.providers.account.expires_at']({
              value: new Date(provider.expiresAt).toLocaleString(),
            })}
          </div>
        )}
      </div>
    );
  },
};

export const createProviderColumns = (
  deleteDialogRef: React.RefObject<DeleteProviderDialogRef | null>,
  hasDetails: boolean,
): ColumnDef<DashboardProviderSummary>[] => [
  providerColumn,
  statusColumn,
  ...(hasDetails ? [detailsColumn] : []),
  {
    id: 'models',
    accessorFn: (provider) => (provider.clientModels ?? []).join(', '),
    header: () => m['dashboard.providers.table.col_models'](),
    cell: ({ row }) => <ProviderModelsCell models={row.original.clientModels ?? []} />,
  },
  {
    id: 'actions',
    enableSorting: false,
    header: () => '',
    cell: ({ row }) =>
      canEditProvider(row.original) ? (
        <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={m['dashboard.providers.actions.delete_provider']({ id: row.original.id })}
          onClick={() => deleteDialogRef.current?.open(row.original)}
        >
          <Trash2 />
        </Button>
      ),
  },
];
