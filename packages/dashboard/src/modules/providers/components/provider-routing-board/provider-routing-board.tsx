import { m } from '@aio-proxy/i18n';
import type { DashboardProviderSummary } from '@aio-proxy/types';
import type React from 'react';

import { WeightedTierBoard, type WeightedTierBoardTier } from '@/components/weighted-tier-board';

import {
  applyProviderRoutingLayout,
  applyProviderShare,
  providerTierPercentages,
  type ProviderRoutingBoard as ProviderRoutingBoardModel,
} from '../../lib/provider-routing-board';
import { ProviderRoutingItem } from './provider-routing-item';

interface ProviderRoutingBoardProps {
  readonly board: ProviderRoutingBoardModel;
  readonly providers: readonly DashboardProviderSummary[];
  readonly onChange: (board: ProviderRoutingBoardModel) => void;
}

export const ProviderRoutingBoard: React.FC<ProviderRoutingBoardProps> = ({ board, providers, onChange }) => {
  const providersById = new Map(providers.map((provider) => [provider.id, provider]));
  const tiers: WeightedTierBoardTier<DashboardProviderSummary>[] = board.tiers.map((tier) => {
    const percentages = providerTierPercentages(tier);
    return {
      id: tier.id,
      items: tier.items.flatMap((item) => {
        const provider = providersById.get(item.providerId);
        if (provider === undefined) return [];
        const share = percentages.get(provider.id) ?? 0;
        return [
          {
            id: provider.id,
            value: provider,
            draggable: true,
            dragLabel: m['dashboard.providers.routing.drag_provider']({ providerId: provider.id }),
            shareLabel: item.weight > 0 ? `${share}%` : m['dashboard.providers.routing.parked'](),
            shareTestId: `provider-share-${provider.id}`,
            testId: `provider-routing-item-${provider.id}`,
            // Every member gets a slider, including the only one in its tier: zero is part of the
            // range and parks the Provider outside normal routing while leaving its Provider-qualified
            // route reachable, so a tier of one still has that one question to answer. Raising the
            // slider again is how a parked Provider returns to the split.
            control: {
              ariaLabel: m['dashboard.providers.routing.share_aria']({ providerId: provider.id }),
              min: 0,
              max: 100,
              step: 1,
              value: share,
              testId: `provider-share-slider-${provider.id}`,
              onChange: (value: number) => onChange(applyProviderShare(board, tier.id, provider.id, value)),
            },
          },
        ];
      }),
    };
  });

  return (
    <WeightedTierBoard
      tiers={tiers}
      writable
      labels={{
        tier: (index) => m['dashboard.providers.routing.tier']({ tier: index + 1 }),
        tierCount: (count) => m['dashboard.providers.routing.provider_count']({ count }),
        dragTier: (index) => m['dashboard.providers.routing.drag_tier']({ tier: index + 1 }),
        newTier: m['dashboard.providers.routing.add_tier'](),
        emptyTier: m['dashboard.providers.routing.empty_tier'](),
      }}
      renderItem={(provider) => <ProviderRoutingItem provider={provider} />}
      onLayoutChange={(layout, operation) => onChange(applyProviderRoutingLayout(board, layout, operation))}
      testId="provider-routing-board"
      tierTestId={(index) => `provider-tier-${index + 1}`}
      slotTestId={(listId) => `provider-routing-slot-${listId}`}
    />
  );
};
