import { m } from '@aio-proxy/i18n';
import type { DashboardPluginSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { TableRow } from '@aio-proxy/ui/components/table';
import { Subscribe, type Row } from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';

import { PluginIcon } from '@/components/plugin-icon';
import { formatCompactTokenCount } from '@/components/token-count';
import type { DataTableFeatures } from '@/hooks/use-data-table';
import { resolveDashboardText } from '@/lib/localized-text';

import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderModelsCell } from '../provider-models-cell';
import { ProviderTableCell } from '../providers-table/provider-table-cell';
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
  let pluginLabel = group.groupKey;
  if (provider?.plugin !== undefined) {
    pluginLabel =
      pluginPresentation?.displayName === undefined
        ? provider.plugin
        : resolveDashboardText(pluginPresentation.displayName);
  }
  let groupLabel = group.groupKey;
  if (provider !== undefined) {
    groupLabel = provider.capability === 'default' ? pluginLabel : `${pluginLabel}/${provider.capability ?? ''}`;
  }
  const toggleExpanded = () => row.toggleExpanded();
  return (
    <Subscribe source={row.table.atoms.expanded} selector={() => row.getIsExpanded()}>
      {(expanded) => {
        const renderCell = (cell: ReturnType<typeof row.getAllCells>[number]) => {
          switch (cell.column.id) {
            case 'aggregate':
              return (
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
              );
            case 'provider':
              return (
                <div className="flex items-center gap-2 font-medium">
                  {pluginPresentation?.icon === undefined ? null : (
                    <PluginIcon icon={pluginPresentation.icon} size={16} className="shrink-0" />
                  )}
                  <span>{groupLabel}</span>
                </div>
              );
            case 'type':
              return <span>OAuth</span>;
            case 'models':
              return <ProviderModelsCell models={models} />;
            case 'usage':
              return <span className="tabular-nums">{formatCompactTokenCount(requestCount)}</span>;
            default:
              return null;
          }
        };
        return (
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
            {row.getVisibleCells().map((cell) => (
              <ProviderTableCell key={cell.id} cell={cell}>
                {renderCell(cell)}
              </ProviderTableCell>
            ))}
          </TableRow>
        );
      }}
    </Subscribe>
  );
};
