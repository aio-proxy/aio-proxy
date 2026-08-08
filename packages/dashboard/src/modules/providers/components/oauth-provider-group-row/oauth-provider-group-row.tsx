import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';
import { Subscribe, type Row } from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';
import { formatCompactTokenCount } from '@/components/token-count';
import type { DataTableFeatures } from '@/hooks/use-data-table';
import { resolveDashboardText } from '@/lib/localized-text';

import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderModelsCell } from '../provider-models-cell';
import type { ProviderTableRow } from '../providers-table/provider-table-row';

interface OAuthProviderGroupRowProps {
  readonly pluginPresentations: ReadonlyMap<string, Pick<DashboardPluginSummary, 'displayName' | 'icon'>>;
  readonly row: Row<DataTableFeatures, ProviderTableRow>;
  readonly providerUsage: ReadonlyMap<string, ProviderUsage>;
}

export const OAuthProviderGroupRow: React.FC<OAuthProviderGroupRowProps> = ({
  pluginPresentations,
  row,
  providerUsage,
}) => {
  const group = row.original;
  if (group.rowType !== 'oauth-group') return null;

  const requestCount = group.accounts.reduce(
    (total, { provider }) => total + (providerUsage.get(provider.id)?.requestCount ?? 0n),
    0n,
  );
  const models = [...new Set(group.accounts.flatMap(({ provider }) => provider.clientModels))];
  const provider = group.accounts[0]?.provider;
  const pluginPresentation = provider?.plugin === undefined ? undefined : pluginPresentations.get(provider.plugin);
  const pluginLabel =
    provider?.plugin === undefined
      ? group.groupKey
      : pluginPresentation?.displayName === undefined
        ? provider.plugin
        : resolveDashboardText(pluginPresentation.displayName);
  const groupLabel =
    provider === undefined
      ? group.groupKey
      : provider.capability === 'default'
        ? pluginLabel
        : `${pluginLabel}/${provider.capability ?? ''}`;
  const toggleExpanded = () => row.toggleExpanded();
  return (
    <Subscribe source={row.table.atoms.expanded} selector={() => row.getIsExpanded()}>
      {(expanded) => (
        <TableRow
          tabIndex={0}
          data-testid={`provider-group-${group.groupKey}`}
          className="cursor-pointer focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          onClick={toggleExpanded}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleExpanded();
          }}
        >
          {row.getAllCells().map((cell) => (
            <TableCell key={cell.id} className={cell.column.columnDef.meta?.tableCellClassName}>
              {cell.column.id === 'aggregate' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="h-7 w-7 p-0"
                  aria-label={
                    expanded
                      ? m['dashboard.providers.table.collapse_group']()
                      : m['dashboard.providers.table.expand_group']()
                  }
                  aria-expanded={expanded}
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleExpanded();
                  }}
                >
                  {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
                </Button>
              ) : cell.column.id === 'provider' ? (
                <div className="flex items-center gap-2 font-medium">
                  {pluginPresentation?.icon === undefined ? null : (
                    <PluginIcon icon={pluginPresentation.icon} size={16} className="shrink-0" />
                  )}
                  <span>{groupLabel}</span>
                </div>
              ) : cell.column.id === 'type' ? (
                <span>OAuth</span>
              ) : cell.column.id === 'models' ? (
                <ProviderModelsCell models={models} />
              ) : cell.column.id === 'usage' ? (
                <span className="tabular-nums">{formatCompactTokenCount(requestCount)}</span>
              ) : null}
            </TableCell>
          ))}
        </TableRow>
      )}
    </Subscribe>
  );
};
