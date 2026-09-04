import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable';
import { useDroppable } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import {
  providerTierPercentages,
  providerTierListId,
  PROVIDER_TIER_ORDER,
  type ProviderRoutingBoardTier,
} from '../../lib/provider-routing-board';
import type { ProviderHealth } from '../../services/provider-health-service';
import type { ProviderUsage } from '../../services/provider-usage-service';
import { ProviderRoutingCard } from './provider-routing-card';

const SORTABLE_PLUGINS = [SortableKeyboardPlugin];

interface ProviderTierProps {
  readonly tier: ProviderRoutingBoardTier;
  readonly tierIndex: number;
  readonly providersById: ReadonlyMap<string, DashboardProviderSummary>;
  readonly visibleProviderIds: ReadonlySet<string>;
  readonly editing: boolean;
  readonly health: ReadonlyMap<string, ProviderHealth> | undefined;
  readonly usage: ReadonlyMap<string, ProviderUsage> | undefined;
  readonly usagePending: boolean;
  readonly pluginPresentations: ReadonlyMap<string, { readonly displayName?: string; readonly icon?: string }>;
  readonly focusedProviderId: string | undefined;
  readonly onShareChange: (providerId: string, share: number) => void;
  readonly onDelete: (provider: DashboardProviderSummary) => void;
}

export const ProviderTier: React.FC<ProviderTierProps> = ({
  tier,
  tierIndex,
  providersById,
  visibleProviderIds,
  editing,
  health,
  usage,
  usagePending,
  pluginPresentations,
  focusedProviderId,
  onShareChange,
  onDelete,
}) => {
  const { ref, handleRef, isDragging } = useSortable({
    id: tier.id,
    index: tierIndex,
    group: PROVIDER_TIER_ORDER,
    type: 'tier',
    accept: 'tier',
    disabled: !editing,
    plugins: SORTABLE_PLUGINS,
  });
  const { ref: dropRef, isDropTarget } = useDroppable({
    id: providerTierListId(tier.id),
    type: 'list',
    accept: 'provider',
    disabled: !editing,
  });
  const percentages = providerTierPercentages(tier);
  const visibleItems = editing ? tier.items : tier.items.filter((item) => visibleProviderIds.has(item.providerId));

  return (
    <section
      ref={editing ? ref : undefined}
      data-testid={`provider-tier-${tierIndex + 1}`}
      data-dragging={isDragging || undefined}
      className={cn(
        '@container/tier rounded-2xl border bg-card p-4 shadow-sm transition-colors',
        isDragging && 'opacity-70',
        isDropTarget && 'border-primary bg-primary/5',
      )}
    >
      <div className="mb-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3">
        {editing ? (
          <Button
            ref={handleRef}
            type="button"
            size="sm"
            variant="secondary"
            className="cursor-grab active:cursor-grabbing"
            aria-label={m['dashboard.providers.routing.drag_tier']({ tier: tierIndex + 1 })}
          >
            <GripVertical />
            {tierIndex + 1}
          </Button>
        ) : (
          <span className="flex size-7 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-muted-foreground">
            {tierIndex + 1}
          </span>
        )}
        <h2 className="font-heading text-sm font-medium">
          {m['dashboard.providers.routing.tier']({ tier: tierIndex + 1 })}
        </h2>
        <span className="text-xs text-muted-foreground">
          {m['dashboard.providers.routing.provider_count']({ count: tier.items.length })}
        </span>
      </div>
      <div
        ref={dropRef}
        className={cn(
          'grid min-h-24 grid-cols-1 gap-3 @3xl/tier:grid-cols-2 @5xl/tier:grid-cols-3',
          editing && tier.items.length === 0 && 'rounded-xl border border-dashed p-4',
        )}
      >
        {visibleItems.length === 0 ? (
          <p className="col-span-full flex min-h-16 items-center justify-center text-xs text-muted-foreground">
            {editing ? m['dashboard.providers.routing.empty_tier']() : m['dashboard.providers.card.no_matches']()}
          </p>
        ) : (
          visibleItems.map((item, index) => {
            const provider = providersById.get(item.providerId);
            if (provider === undefined) return null;
            const presentation = provider.plugin === undefined ? undefined : pluginPresentations.get(provider.plugin);
            return (
              <ProviderRoutingCard
                key={provider.id}
                provider={provider}
                tierListId={providerTierListId(tier.id)}
                index={index}
                share={percentages.get(provider.id) ?? 0}
                editing={editing}
                health={health?.get(provider.id)}
                usage={usage?.get(provider.id)}
                usagePending={usagePending}
                pluginLabel={presentation?.displayName}
                pluginIcon={presentation?.icon}
                focused={provider.id === focusedProviderId}
                canAdjustShare={tier.items.length > 1}
                onShareChange={(share) => onShareChange(provider.id, share)}
                onDelete={onDelete}
              />
            );
          })
        )}
      </div>
    </section>
  );
};
