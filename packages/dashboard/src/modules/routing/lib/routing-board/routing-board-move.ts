import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { ROUTING_VALUE_MAX } from '@aio-proxy/types';

import type { WeightedTierLayout } from '@/lib/weighted-tier-layout';

import { type RoutingBoard, type RoutingBoardDraftRow, applyRoutingBoardLayout } from './routing-board';

/** The board as the drag layer sees it: one list per tier, keyed `tier:<priority>`, plus parking. */
export const routingBoardLayout = (board: RoutingBoard): WeightedTierLayout => ({
  tiers: board.tiers.map((tier) => ({
    id: `tier:${tier.priority}`,
    itemIds: tier.items.map((item) => item.providerId),
  })),
  parking: {
    unused: board.unused.map((item) => item.providerId),
    ...(board.blocked.length === 0 ? {} : { blocked: board.blocked.map((item) => item.providerId) }),
  },
});

export type RoutingMoveTarget =
  | { readonly type: 'tier'; readonly index: number }
  | { readonly type: 'new-tier' }
  | { readonly type: 'unused' };

/**
 * The keyboard and menu counterpart of dragging one Provider: the same layout change a drop would
 * make, applied through the same `applyRoutingBoardLayout`, so both paths assign priorities alike.
 */
export const moveRoutingProvider = ({
  providers,
  rows,
  board,
  providerId,
  target,
}: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly rows: readonly RoutingBoardDraftRow[];
  readonly board: RoutingBoard;
  readonly providerId: string;
  readonly target: RoutingMoveTarget;
}): RoutingBoardDraftRow[] => {
  const previousLayout = routingBoardLayout(board);
  const without = (ids: readonly string[]) => ids.filter((id) => id !== providerId);
  const tiers = previousLayout.tiers.map((tier, index) => ({
    id: tier.id,
    itemIds:
      target.type === 'tier' && target.index === index ? [...without(tier.itemIds), providerId] : without(tier.itemIds),
  }));
  const nextLayout: WeightedTierLayout = {
    // A new tier goes last: an id outside `tier:<n>` has no priority to keep, so one is allocated
    // below the lowest existing tier.
    tiers: target.type === 'new-tier' ? [...tiers, { id: 'tier:new', itemIds: [providerId] }] : tiers,
    parking: Object.fromEntries(
      Object.entries(previousLayout.parking).map(([id, itemIds]) => [
        id,
        target.type === 'unused' && id === 'unused' ? [...without(itemIds), providerId] : without(itemIds),
      ]),
    ),
  };
  return applyRoutingBoardLayout({
    providers,
    previousRows: rows,
    previousLayout,
    nextLayout,
    operation: { type: 'item', id: providerId },
  });
};

/** A typed weight. Equal to the Provider default, it drops back to the default instead of pinning it. */
export const applyRoutingWeight = ({
  providers,
  rows,
  providerId,
  weight,
}: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly rows: readonly RoutingBoardDraftRow[];
  readonly providerId: string;
  readonly weight: number;
}): RoutingBoardDraftRow[] => {
  const provider = providers.find((entry) => entry.id === providerId);
  if (provider === undefined) return [...rows];
  const bounded = Math.min(ROUTING_VALUE_MAX, Math.max(1, Math.round(weight)));
  return rows.map((row) => {
    if (row.providerId !== providerId) return row;
    const { weight: _previous, ...rest } = row;
    return bounded === provider.defaults.weight.effective ? rest : { ...rest, weight: bounded };
  });
};

/** Column template shared by the route's header row and every Provider row, so the columns align. */
export const ROUTING_BOARD_ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_7rem_3.5rem_3.5rem_5rem_3.5rem_2rem] items-center gap-x-3';
