import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import { useDroppable } from '@dnd-kit/react';
import type React from 'react';

import type { ProviderRoutingBoardItem } from '../../lib/provider-routing-board';
import { ProviderRoutingCard } from './provider-routing-card';

interface ProviderTierSlotProps {
  readonly listId: string;
  readonly items: readonly ProviderRoutingBoardItem[];
  readonly providersById: ReadonlyMap<string, DashboardProviderSummary>;
}

export const ProviderTierSlot: React.FC<ProviderTierSlotProps> = ({ listId, items, providersById }) => {
  const { ref, isDropTarget } = useDroppable({ id: listId, type: 'list', accept: 'provider' });
  const className =
    items.length === 0
      ? 'h-2 rounded-md data-drop-target:border data-drop-target:border-dashed data-drop-target:border-border'
      : 'space-y-2 rounded-xl border border-dashed p-2 data-drop-target:border-primary';

  return (
    <section
      ref={ref}
      aria-label={m['dashboard.providers.routing.add_tier']()}
      data-testid={`provider-routing-slot-${listId}`}
      data-drop-target={isDropTarget || undefined}
      className={className}
    >
      {items.map((item, index) => {
        const provider = providersById.get(item.providerId);
        return provider === undefined ? null : (
          <ProviderRoutingCard
            key={provider.id}
            provider={provider}
            tierListId={listId}
            index={index}
            share={100}
            canAdjustShare={false}
            onShareChange={() => undefined}
          />
        );
      })}
    </section>
  );
};
