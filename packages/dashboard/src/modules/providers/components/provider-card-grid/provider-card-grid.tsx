import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Empty } from '@aio-proxy/ui/components/empty';
import { useQuery } from '@tanstack/react-query';
import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { resolveDashboardText } from '@/lib/localized-text';

import { emptyProviderListFilters, visibleProviders } from '../../lib/provider-list-view';
import { providerHealthQueryOptions } from '../../services/provider-health-service';
import { providerPluginPresentationsQueryOptions } from '../../services/provider-plugin-labels';
import { providerUsageQueryOptions } from '../../services/provider-usage-service';
import { DeleteProviderDialog, type DeleteProviderDialogRef } from '../delete-provider-dialog';
import { ProviderCard } from '../provider-card';
import { ProviderFilterChips } from './provider-filter-chips';
import { ProviderSearchField } from './provider-search-field';

interface ProviderCardGridProps {
  readonly providers: readonly DashboardProviderSummary[];
  readonly focusProviderId?: string;
}

export const ProviderCardGrid: React.FC<ProviderCardGridProps> = ({ providers, focusProviderId }) => {
  const [filters, setFilters] = useState(emptyProviderListFilters);
  const deleteDialogRef = useRef<DeleteProviderDialogRef>(null);
  const usageQuery = useQuery(providerUsageQueryOptions());
  const healthQuery = useQuery(providerHealthQueryOptions());
  const pluginsQuery = useQuery(providerPluginPresentationsQueryOptions());

  const pluginPresentations = useMemo(
    () => new Map((pluginsQuery.data?.plugins ?? []).map((plugin) => [plugin.packageName, plugin])),
    [pluginsQuery.data],
  );
  const visible = useMemo(() => visibleProviders(providers, filters), [providers, filters]);

  useEffect(() => {
    if (focusProviderId === undefined) return;
    // Two frames: the first lets React commit the grid, the second lets layout settle before scrolling.
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const card = document.getElementById(`provider-row-${focusProviderId}`);
        card?.scrollIntoView?.({ block: 'center' });
        // The identity link is the card's only focusable anchor; the container itself is not tabbable.
        (document.getElementById(`provider-link-${focusProviderId}`) ?? card)?.focus();
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusProviderId, visible]);

  if (providers.length === 0) return <Empty>{m['dashboard.providers.empty_state']()}</Empty>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3">
        <ProviderSearchField value={filters.search} onChange={(search) => setFilters({ ...filters, search })} />
        <ProviderFilterChips filters={filters} onChange={setFilters} />
      </div>

      {visible.length === 0 ? (
        <p role="status" data-testid="providers-no-matches" className="p-6 text-center text-sm text-muted-foreground">
          {m['dashboard.providers.card.no_matches']()}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((provider) => {
            const presentation = provider.plugin === undefined ? undefined : pluginPresentations.get(provider.plugin);
            return (
              <ProviderCard
                key={provider.id}
                provider={provider}
                health={healthQuery.data?.get(provider.id)}
                usage={usageQuery.data?.get(provider.id)}
                usagePending={usageQuery.isPending}
                pluginLabel={
                  presentation?.displayName === undefined ? undefined : resolveDashboardText(presentation.displayName)
                }
                pluginIcon={presentation?.icon}
                focused={provider.id === focusProviderId}
                onDelete={(target) => deleteDialogRef.current?.open(target)}
              />
            );
          })}
        </div>
      )}

      <DeleteProviderDialog ref={deleteDialogRef} />
    </div>
  );
};
