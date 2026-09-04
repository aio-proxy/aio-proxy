import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { Button } from '@aio-proxy/ui/components/button';
import { cn } from '@aio-proxy/ui/lib/utils';
import { SortableKeyboardPlugin } from '@dnd-kit/dom/sortable';
import { useDragOperation, useDroppable } from '@dnd-kit/react';
import { useSortable } from '@dnd-kit/react/sortable';
import { GripVertical } from 'lucide-react';
import type React from 'react';

import {
  providerTierPercentages,
  providerTierListId,
  PROVIDER_TIER_ORDER,
  type ProviderRoutingBoardTier,
} from '../../lib/provider-routing-board';
import { ProviderRoutingCard } from './provider-routing-card';

const SORTABLE_PLUGINS = [SortableKeyboardPlugin];

interface ProviderTierProps {
  readonly tier: ProviderRoutingBoardTier;
  readonly tierIndex: number;
  readonly providersById: ReadonlyMap<string, DashboardProviderSummary>;
  readonly onShareChange: (providerId: string, share: number) => void;
}

export const ProviderTier: React.FC<ProviderTierProps> = ({ tier, tierIndex, providersById, onShareChange }) => {
  const { source } = useDragOperation();
  const tiersCollapsed = source?.type === 'tier';
  const {
    ref,
    handleRef,
    isDragging,
    isDropTarget: isTierDropTarget,
  } = useSortable({
    id: tier.id,
    index: tierIndex,
    group: PROVIDER_TIER_ORDER,
    type: 'tier',
    accept: 'tier',
    plugins: SORTABLE_PLUGINS,
  });
  const { ref: dropRef, isDropTarget: isProviderDropTarget } = useDroppable({
    id: providerTierListId(tier.id),
    type: 'list',
    accept: 'provider',
  });
  const percentages = providerTierPercentages(tier);
  const highlighted = isProviderDropTarget || (isTierDropTarget && !isDragging);

  return (
    <section
      ref={ref}
      data-testid={`provider-tier-${tierIndex + 1}`}
      data-dragging={isDragging || undefined}
      data-drop-target={highlighted || undefined}
      className={cn(
        'space-y-2 rounded-xl border bg-muted/40 p-3 transition-colors',
        isDragging && 'opacity-70',
        highlighted && 'border-primary bg-primary/5',
      )}
    >
      <div className="flex items-center gap-3">
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
        <h2 className="min-w-0 flex-1 font-heading text-sm font-medium">
          {m['dashboard.providers.routing.tier']({ tier: tierIndex + 1 })}
        </h2>
        <span className="text-xs text-muted-foreground">
          {m['dashboard.providers.routing.provider_count']({ count: tier.items.length })}
        </span>
      </div>
      <div
        className={cn(
          'grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none',
          tiersCollapsed ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
        )}
      >
        <div
          ref={dropRef}
          aria-hidden={tiersCollapsed || undefined}
          inert={tiersCollapsed || undefined}
          className={cn(
            'min-h-0 space-y-2 overflow-hidden',
            tier.items.length === 0 && 'min-h-16 rounded-lg border border-dashed p-2',
          )}
        >
          {tier.items.length === 0 ? (
            <p className="flex min-h-12 items-center justify-center text-xs text-muted-foreground">
              {m['dashboard.providers.routing.empty_tier']()}
            </p>
          ) : (
            tier.items.map((item, index) => {
              const provider = providersById.get(item.providerId);
              if (provider === undefined) return null;
              return (
                <ProviderRoutingCard
                  key={provider.id}
                  provider={provider}
                  tierListId={providerTierListId(tier.id)}
                  index={index}
                  share={percentages.get(provider.id) ?? 0}
                  canAdjustShare={tier.items.length > 1}
                  onShareChange={(share) => onShareChange(provider.id, share)}
                />
              );
            })
          )}
        </div>
      </div>
    </section>
  );
};
