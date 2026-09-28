import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import { RoutingTierLabel } from '@/components/routing-tier-label';
import { WeightedTierBoard, type WeightedTierBoardTier } from '@/components/weighted-tier-board';

import {
  applyProviderRoutingLayout,
  applyProviderWeight,
  providerRoutingMutation,
  providerTierPercentages,
  type ProviderRoutingBoard as ProviderRoutingBoardModel,
} from '../../lib/provider-routing-board';
import { ProviderRoutingColumns } from './provider-routing-columns';
import { ProviderRoutingItem } from './provider-routing-item';

interface ProviderRoutingRow {
  readonly provider: DashboardProviderSummary;
  readonly tierId: string;
  readonly weight: number;
  readonly share: number;
}

interface ProviderRoutingBoardProps {
  readonly board: ProviderRoutingBoardModel;
  readonly providers: readonly DashboardProviderSummary[];
  readonly onChange: (board: ProviderRoutingBoardModel) => void;
}

export const ProviderRoutingBoard: React.FC<ProviderRoutingBoardProps> = ({ board, providers, onChange }) => {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const prioritiesByProviderId = new Map(
    Object.entries(providerRoutingMutation(board, '').providers).map(
      ([providerId, value]) => [providerId, value.priority] as const,
    ),
  );
  const tiers: WeightedTierBoardTier<ProviderRoutingRow>[] = board.tiers.map((tier) => {
    const percentages = providerTierPercentages(tier);
    const priority =
      tier.items.map((item) => prioritiesByProviderId.get(item.providerId)).find((value) => value !== undefined) ?? 0;
    return {
      id: tier.id,
      priority,
      items: tier.items.flatMap((item) => {
        const provider = providersById.get(item.providerId);
        if (provider === undefined) return [];
        return [
          {
            id: provider.id,
            value: { provider, tierId: tier.id, weight: item.weight, share: percentages.get(provider.id) ?? 0 },
            draggable: true,
            dragLabel: m['dashboard.providers.routing.drag_provider']({ providerId: provider.id }),
            testId: `provider-routing-item-${provider.id}`,
          },
        ];
      }),
    };
  });

  return (
    <WeightedTierBoard
      columns={<ProviderRoutingColumns />}
      tiers={tiers}
      writable
      labels={{
        tier: (index, priority) => (
          <span className="flex w-full items-center gap-2.5">
            <RoutingTierLabel tier={index + 1} priority={priority} />
            <span className="truncate font-sans text-xs font-normal text-muted-foreground">
              {index === 0 ? m['dashboard.routing.tier_label.primary']() : m['dashboard.routing.tier_label.fallback']()}
            </span>
          </span>
        ),
        dragTier: (index) => m['dashboard.providers.routing.drag_tier']({ tier: index + 1 }),
        newTier: m['dashboard.providers.routing.add_tier'](),
        emptyTier: m['dashboard.providers.routing.empty_tier'](),
      }}
      renderItem={({ provider, tierId, weight, share }) => (
        <ProviderRoutingItem
          provider={provider}
          weight={weight}
          share={share}
          onWeightChange={(next) => onChange(applyProviderWeight(board, tierId, provider.id, next))}
        />
      )}
      onLayoutChange={(layout, operation) => onChange(applyProviderRoutingLayout(board, layout, operation))}
      testId="provider-routing-board"
      tierTestId={(index) => `provider-tier-${index + 1}`}
      slotTestId={(listId) => `provider-routing-slot-${listId}`}
    />
  );
};
