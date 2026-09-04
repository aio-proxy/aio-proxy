import { m } from '@aio-proxy/i18n';
import { ROUTING_VALUE_MAX, type DashboardRoutingModel, type DashboardRoutingProvider } from '@aio-proxy/types';
import { useMemo } from 'react';

import {
  WeightedTierBoard,
  type WeightedTierBoardItem,
  type WeightedTierBoardTier,
  type WeightedTierParkingList,
} from '@/components/weighted-tier-board';
import type { WeightedTierLayout } from '@/lib/weighted-tier-layout';

import type { RoutingFormProviderRow, useRoutingForm } from '../hooks/use-routing-form';
import {
  applyRoutingBoardLayout,
  applyRoutingShare,
  buildRoutingBoard,
  type RoutingBoardItem as RoutingBoardItemModel,
} from '../lib/routing-board';
import { formatRoutingShareValue } from '../lib/routing-summary';
import { RoutingBoardItem } from './routing-board-item';

interface RoutingBoardCanvasProps {
  readonly form: ReturnType<typeof useRoutingForm>;
  readonly model: DashboardRoutingModel;
  readonly rows: readonly RoutingFormProviderRow[];
  readonly writable: boolean;
}

interface RoutingBoardItemView {
  readonly hasOverride: boolean;
  readonly index: number;
  readonly item: RoutingBoardItemModel;
  readonly provider: DashboardRoutingProvider;
}

export const RoutingBoardCanvas: React.FC<RoutingBoardCanvasProps> = ({ form, model, rows, writable }) => {
  const board = useMemo(() => buildRoutingBoard(model.providers, rows), [model.providers, rows]);
  const providersById = new Map(model.providers.map((provider) => [provider.id, provider]));
  const rowsById = new Map(
    rows.map((row, index) => [
      row.providerId,
      { index, hasOverride: row.priority !== undefined || row.weight !== undefined },
    ]),
  );
  const toItem = (item: RoutingBoardItemModel): WeightedTierBoardItem<RoutingBoardItemView>[] => {
    const provider = providersById.get(item.providerId);
    const row = rowsById.get(item.providerId);
    if (provider === undefined || row === undefined) return [];
    return [
      {
        id: item.providerId,
        value: { provider, item, ...row },
        draggable: item.draggable,
        dragLabel: m['dashboard.providers.routing.drag_provider']({ providerId: item.providerId }),
        testId: `routing-provider-${item.providerId}`,
      },
    ];
  };
  const tiers: WeightedTierBoardTier<RoutingBoardItemView>[] = board.tiers.map((tier) => {
    const total = tier.items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    const basis = total > tier.items.length ? total : ROUTING_VALUE_MAX;
    const shareMax = Math.max(1, Math.min(ROUTING_VALUE_MAX, basis - (tier.items.length - 1)));
    return {
      id: `tier:${tier.priority}`,
      items: tier.items.flatMap((item) =>
        toItem(item).map((entry) => ({
          ...entry,
          ...(item.share === null
            ? {}
            : {
                shareLabel: m['dashboard.routing.editor.share']({ value: formatRoutingShareValue(item.share) }),
                shareTestId: `routing-share-${item.providerId}`,
              }),
          control:
            tier.items.length < 2 || item.share === null
              ? undefined
              : {
                  ariaLabel: m['dashboard.routing.editor.share_control'](),
                  min: 0,
                  max: basis,
                  value: Math.max(0, Math.round(item.share * basis)),
                  testId: `routing-share-slider-${item.providerId}`,
                  onChange: (value: number) => {
                    form.setFieldValue(
                      'providers',
                      applyRoutingShare({
                        providers: model.providers,
                        rows: form.getFieldValue('providers') ?? [],
                        memberIds: tier.items.map((member) => member.providerId),
                        providerId: item.providerId,
                        weight: Math.min(shareMax, Math.max(1, value)),
                      }),
                    );
                  },
                },
        })),
      ),
    };
  });
  const parking: WeightedTierParkingList<RoutingBoardItemView>[] = [
    {
      id: 'unused',
      label: m['dashboard.routing.editor.unused'](),
      items: board.unused.flatMap(toItem),
      droppable: true,
      testId: 'routing-list-unused',
    },
    ...(board.blocked.length === 0
      ? []
      : [
          {
            id: 'blocked',
            label: m['dashboard.routing.editor.blocked'](),
            items: board.blocked.flatMap(toItem),
            droppable: false,
            testId: 'routing-list-blocked',
          },
        ]),
  ];
  const previousLayout: WeightedTierLayout = {
    tiers: tiers.map((tier) => ({ id: tier.id, itemIds: tier.items.map((item) => item.id) })),
    parking: Object.fromEntries(parking.map((list) => [list.id, list.items.map((item) => item.id)])),
  };

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{m['dashboard.routing.editor.board_help']()}</p>
      <WeightedTierBoard
        tiers={tiers}
        parking={parking}
        writable={writable}
        labels={{
          tier: (index) => m['dashboard.routing.editor.tier']({ value: index + 1 }),
          tierCount: (count) => m['dashboard.providers.routing.provider_count']({ count }),
          dragTier: (index) => m['dashboard.providers.routing.drag_tier']({ tier: index + 1 }),
          newTier: m['dashboard.routing.editor.new_priority'](),
          emptyTier: m['dashboard.providers.routing.empty_tier'](),
        }}
        renderItem={({ provider, index, item, hasOverride }) => (
          <RoutingBoardItem
            form={form}
            provider={provider}
            index={index}
            weight={item.weight}
            writable={writable}
            hasOverride={hasOverride}
          />
        )}
        onLayoutChange={(nextLayout, operation) => {
          form.setFieldValue(
            'providers',
            applyRoutingBoardLayout({
              providers: model.providers,
              previousRows: rows,
              previousLayout,
              nextLayout,
              operation,
            }),
          );
        }}
        testId="routing-board"
        tierTestId={(_index, id) => `routing-list-${id}`}
      />
    </div>
  );
};
