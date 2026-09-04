import {
  ROUTING_VALUE_MAX,
  type DashboardProviderRoutingMutation,
  type DashboardProviderSummary,
} from '@aio-proxy/types';

import type { WeightedTierLayout, WeightedTierOperation } from '@/lib/weighted-tier-layout';

import { isDegradedProvider } from '../provider-list-view';

export interface ProviderRoutingBoardItem {
  readonly providerId: string;
  readonly weight: number;
}

export interface ProviderRoutingBoardTier {
  readonly id: string;
  readonly items: readonly ProviderRoutingBoardItem[];
}

export interface ProviderRoutingBoard {
  readonly tiers: readonly ProviderRoutingBoardTier[];
}

const effectivePriority = (provider: DashboardProviderSummary): number => provider.priority ?? 0;
const effectiveWeight = (provider: DashboardProviderSummary): number => Math.max(0, provider.weight ?? 1);

const distribute = (total: number, weights: readonly number[]): number[] => {
  if (weights.length === 0) return [];
  const weightTotal = weights.reduce((sum, value) => sum + Math.max(0, value), 0);
  const exact = weights.map((value) =>
    weightTotal === 0 ? total / weights.length : (Math.max(0, value) / weightTotal) * total,
  );
  const values = exact.map((value) => Math.floor(value));
  let remainder = total - values.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let cursor = 0; remainder > 0; cursor += 1, remainder -= 1) {
    const index = order[cursor % order.length]?.index;
    if (index !== undefined) values[index] = (values[index] ?? 0) + 1;
  }
  return values;
};

const positiveDistribution = (total: number, weights: readonly number[]): number[] => {
  if (weights.length === 0) return [];
  const base = weights.map(() => 1);
  // Every member keeps at least one point, so only the surplus above that floor is distributable.
  const extra = distribute(
    Math.max(0, total - weights.length),
    weights.map((weight) => Math.max(1, weight)),
  );
  return base.map((value, index) => value + (extra[index] ?? 0));
};

// Weight zero deliberately parks a Provider outside normal routing. It holds no share of its tier,
// so it neither receives budget here nor reserves any. `revive` names the Provider the user just
// dragged, so a drag into another tier lands it with a share instead of carrying its zero along;
// raising its share slider is the other way back.
const normalizedItems = (
  items: readonly ProviderRoutingBoardItem[],
  weightOf: (item: ProviderRoutingBoardItem) => number = (item) => item.weight,
  revive?: string,
): ProviderRoutingBoardItem[] => {
  const active = items.filter((item) => item.weight > 0 || item.providerId === revive);
  const weights = positiveDistribution(ROUTING_VALUE_MAX, active.map(weightOf));
  const byId = new Map(active.map((item, index) => [item.providerId, weights[index] ?? 1]));
  return items.map((item) => ({ ...item, weight: byId.get(item.providerId) ?? item.weight }));
};

export const buildProviderRoutingBoard = (providers: readonly DashboardProviderSummary[]): ProviderRoutingBoard => {
  const routable = providers.filter((provider) => !isDegradedProvider(provider));
  const priorities = [...new Set(routable.map(effectivePriority))].sort((left, right) => right - left);
  return {
    tiers: priorities.map((priority) => ({
      id: `tier:${priority}`,
      items: routable
        .filter((provider) => effectivePriority(provider) === priority)
        .sort((left, right) => effectiveWeight(right) - effectiveWeight(left) || left.id.localeCompare(right.id))
        .map((provider) => ({ providerId: provider.id, weight: effectiveWeight(provider) })),
    })),
  };
};

export const providerTierPercentages = (tier: ProviderRoutingBoardTier): ReadonlyMap<string, number> => {
  const active = tier.items.filter((item) => item.weight > 0);
  const percentages = distribute(
    100,
    active.map((item) => item.weight),
  );
  const byId = new Map(active.map((item, index) => [item.providerId, percentages[index] ?? 0]));
  // A parked Provider shows no share, including when every member of the tier is parked.
  return new Map(tier.items.map((item) => [item.providerId, byId.get(item.providerId) ?? 0]));
};

const applyProviderTierOrder = (board: ProviderRoutingBoard, tierIds: readonly string[]): ProviderRoutingBoard => {
  const byId = new Map(board.tiers.map((tier) => [tier.id, tier]));
  return { tiers: tierIds.flatMap((id) => (byId.get(id) === undefined ? [] : [byId.get(id)!])) };
};

export const applyProviderRoutingLayout = (
  board: ProviderRoutingBoard,
  layout: WeightedTierLayout,
  operation: WeightedTierOperation,
): ProviderRoutingBoard => {
  if (operation.type === 'tier') {
    if (!board.tiers.some((tier) => tier.id === operation.id)) return board;
    const byId = new Map(board.tiers.map((tier) => [tier.id, tier]));
    if (
      layout.tiers.length !== board.tiers.length ||
      layout.tiers.some((tier) => {
        const previous = byId.get(tier.id);
        return (
          previous === undefined ||
          previous.items.length !== tier.itemIds.length ||
          previous.items.some((item, index) => item.providerId !== tier.itemIds[index])
        );
      })
    ) {
      return board;
    }
    return applyProviderTierOrder(
      board,
      layout.tiers.map((tier) => tier.id),
    );
  }

  const previousTier = board.tiers.find((tier) => tier.items.some((item) => item.providerId === operation.id));
  if (previousTier === undefined || Object.values(layout.parking).some((itemIds) => itemIds.length > 0)) return board;
  const itemById = new Map(board.tiers.flatMap((tier) => tier.items.map((item) => [item.providerId, item] as const)));
  const nextItemIds = layout.tiers.flatMap((tier) => tier.itemIds);
  if (
    nextItemIds.length !== itemById.size ||
    new Set(nextItemIds).size !== nextItemIds.length ||
    nextItemIds.some((id) => !itemById.has(id))
  ) {
    return board;
  }
  const targetTierId = layout.tiers.find((tier) => tier.itemIds.includes(operation.id))?.id;
  if (targetTierId === undefined) return board;

  const movedAcrossTiers = previousTier.id !== targetTierId;
  return {
    tiers: layout.tiers.map(({ id, itemIds }) => {
      let items = itemIds.flatMap((itemId) => (itemById.get(itemId) === undefined ? [] : [itemById.get(itemId)!]));
      if (movedAcrossTiers && id === previousTier.id) items = normalizedItems(items);
      // The destination tier restarts from an even split so the moved Provider lands with a share,
      // rather than inheriting whatever ratio the source tier happened to hold. The drag is also the
      // only way to unpark a Provider, so it is the one item allowed back into the split at zero.
      if (movedAcrossTiers && id === targetTierId) items = normalizedItems(items, () => 1, operation.id);
      return { id, items };
    }),
  };
};

export const applyProviderShare = (
  board: ProviderRoutingBoard,
  tierId: string,
  providerId: string,
  percentage: number,
): ProviderRoutingBoard => ({
  tiers: board.tiers.map((tier) => {
    if (tier.id !== tierId) return tier;
    // Parked Providers keep their zero and are not part of the split, so the share moves only against
    // the active members. When there are none, the Provider is the whole tier and the only meaningful
    // question the slider asks is whether it is parked at all.
    const others = tier.items.filter((item) => item.providerId !== providerId && item.weight > 0);
    // Zero is a real destination: it parks the Provider outside normal routing while leaving it
    // reachable through its Provider-qualified route, and the slider is the only place to ask for
    // that. Above zero the clamp is in weight space, so every other member keeps a visible one
    // percent while a whole percentage point each still fits and a single weight point beyond —
    // reserving a percent per member in a tier of more than 100 would park the Provider being
    // adjusted instead of the one the user chose.
    const requested = Math.round(percentage);
    const reservePerOther = others.length <= 99 ? ROUTING_VALUE_MAX / 100 : 1;
    const selected =
      requested <= 0
        ? 0
        : Math.max(
            1,
            Math.min(ROUTING_VALUE_MAX - others.length * reservePerOther, requested * (ROUTING_VALUE_MAX / 100)),
          );
    const remaining = positiveDistribution(
      ROUTING_VALUE_MAX - selected,
      others.map((item) => item.weight),
    );
    return {
      ...tier,
      items: tier.items.map((item) => {
        if (item.providerId === providerId) return { ...item, weight: selected };
        const index = others.findIndex((other) => other.providerId === item.providerId);
        return index === -1 ? item : { ...item, weight: remaining[index] ?? 1 };
      }),
    };
  }),
});

const TIER_PRIORITY = /^tier:(\d+)$/;

/**
 * The priorities the board already carries, when they are still usable as-is.
 *
 * A tier ID encodes the priority it was built from, so a save that only moved a weight slider can
 * commit the priorities the config already holds. Rewriting them would be visible beyond this
 * board: exact model overrides are absolute, so recompacting two Providers that both sit at 0 into
 * 20 and 10 flips their order against a model override that pinned one of them at 5.
 *
 * Anything the board changed disqualifies the whole set — a new tier has no encoded priority, and a
 * moved tier leaves the encoded ones out of descending order — and the layout is recompacted. So
 * does a value outside the supported range, which the server would clamp into a collision.
 */
const preservedPriorities = (tiers: readonly ProviderRoutingBoardTier[]): number[] | undefined => {
  const priorities = tiers.map((tier) => Number(TIER_PRIORITY.exec(tier.id)?.[1] ?? Number.NaN));
  return priorities.every(
    (priority, index) => priority <= ROUTING_VALUE_MAX && (index === 0 || priority < (priorities[index - 1] ?? 0)),
  )
    ? priorities
    : undefined;
};

export const providerRoutingMutation = (
  board: ProviderRoutingBoard,
  revision: string,
): DashboardProviderRoutingMutation => {
  const occupied = board.tiers.filter((tier) => tier.items.length > 0);
  // Ten-point spacing leaves room to insert a tier by hand, but it only fits 1000 tiers inside the
  // supported range; beyond that the spacing narrows so every tier the user kept apart stays apart.
  const spacing =
    occupied.length <= ROUTING_VALUE_MAX / 10 ? 10 : Math.max(1, Math.floor(ROUTING_VALUE_MAX / occupied.length));
  // Priorities descend from a top that already fits, rather than being capped per tier: capping would
  // collapse the top two whenever the packed board needs the whole range (10001 tiers at spacing 1).
  const top = Math.min(ROUTING_VALUE_MAX, occupied.length * spacing);
  const preserved = preservedPriorities(occupied);
  return {
    revision,
    providers: Object.fromEntries(
      occupied.flatMap((tier, index) => {
        const priority = preserved?.[index] ?? Math.max(0, top - index * spacing);
        // Weight zero is the authored "parked" value; reordering tiers must not revive that traffic.
        return tier.items.map((item) => [item.providerId, { priority, weight: item.weight }]);
      }),
    ),
  };
};
