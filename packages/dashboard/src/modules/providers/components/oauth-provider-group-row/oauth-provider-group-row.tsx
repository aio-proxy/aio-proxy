import { getLocale, m } from '@aio-proxy/i18n';
import { Button } from '@aio-proxy/ui/components/button';
import { TableCell, TableRow } from '@aio-proxy/ui/components/table';
import { Subscribe, type Row } from '@tanstack/react-table';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type React from 'react';

import { formatCompactTokenCount } from '@/components/token-count';
import type { DataTableFeatures } from '@/hooks/use-data-table';
import { resolveDashboardText } from '@/lib/localized-text';
import { formatNanoUsd } from '@/lib/nano-usd';

import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderModelsCell } from '../provider-models-cell';
import type { ProviderTableRow } from '../providers-table/provider-table-row';

interface OAuthProviderGroupRowProps {
  readonly pluginLabels: ReadonlyMap<string, string | Record<string, string>>;
  readonly row: Row<DataTableFeatures, ProviderTableRow>;
  readonly providerUsage: ReadonlyMap<string, ProviderUsage>;
}

export const OAuthProviderGroupRow: React.FC<OAuthProviderGroupRowProps> = ({ pluginLabels, row, providerUsage }) => {
  const group = row.original;
  if (group.rowType !== 'oauth-group') return null;

  const usage = group.accounts.reduce<ProviderUsage>(
    (total, { provider }) => {
      const account = providerUsage.get(provider.id);
      return account === undefined
        ? total
        : {
            requestCount: total.requestCount + account.requestCount,
            totalTokens: total.totalTokens + account.totalTokens,
            estimatedCostNanoUsd: total.estimatedCostNanoUsd + account.estimatedCostNanoUsd,
          };
    },
    { requestCount: 0n, totalTokens: 0n, estimatedCostNanoUsd: 0n },
  );
  const models = [...new Set(group.accounts.flatMap(({ provider }) => provider.clientModels))];
  const provider = group.accounts[0]?.provider;
  const groupLabel =
    provider === undefined
      ? group.groupKey
      : `${provider.plugin === undefined ? group.groupKey : pluginLabels.get(provider.plugin) === undefined ? provider.plugin : resolveDashboardText(pluginLabels.get(provider.plugin)!)}/${provider.capability ?? ''}`;
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
            <TableCell
              key={cell.id}
              className={
                cell.column.id === 'aggregate'
                  ? 'w-10'
                  : cell.column.id === 'models'
                    ? 'w-20 text-center'
                    : cell.column.id === 'usage'
                      ? 'w-24 text-right'
                      : undefined
              }
            >
              {cell.column.id === 'aggregate' ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
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
                <span className="font-medium">{groupLabel}</span>
              ) : cell.column.id === 'type' ? (
                <span>OAuth</span>
              ) : cell.column.id === 'models' ? (
                <ProviderModelsCell models={models} />
              ) : cell.column.id === 'usage' ? (
                <div className="flex flex-col items-end text-xs tabular-nums">
                  <span>{formatCompactTokenCount(usage.requestCount)}</span>
                  <span>{formatCompactTokenCount(usage.totalTokens)}</span>
                  <span>{formatNanoUsd(usage.estimatedCostNanoUsd, getLocale(), 'compact')}</span>
                </div>
              ) : null}
            </TableCell>
          ))}
        </TableRow>
      )}
    </Subscribe>
  );
};
