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
import { providerUsageQueryOptions, zeroProviderUsage } from '../../services/provider-usage-service';
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

  // Deep-linking focuses the target card once. Keyed on the Provider ID alone: re-running on every
  // filter change would steal focus back from whatever the user is typing in.
  useEffect(() => {
    if (focusProviderId === undefined) return;
    let inner = 0;
    // Two frames: the first lets React commit the grid, the second lets layout settle before scrolling.
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        const card = document.getElementById(`provider-row-${focusProviderId}`);
        card?.scrollIntoView?.({ block: 'center' });
        // The identity link is the card's only focusable anchor; an uneditable card falls back to
        // its own container, which carries `tabIndex={-1}` so `.focus()` still lands.
        (document.getElementById(`provider-link-${focusProviderId}`) ?? card)?.focus();
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, [focusProviderId]);

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
                // A successful response omits Providers with no traffic, so a missing entry means
                // zero requests. Only an unresolved query leaves the count unknown.
                usage={
                  usageQuery.data === undefined ? undefined : (usageQuery.data.get(provider.id) ?? zeroProviderUsage)
                }
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
