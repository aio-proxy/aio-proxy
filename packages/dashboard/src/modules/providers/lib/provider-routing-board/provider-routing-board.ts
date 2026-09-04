import {
  ROUTING_VALUE_MAX,
  type DashboardProviderRoutingMutation,
  type DashboardProviderSummary,
} from '@aio-proxy/types';

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

export const PROVIDER_TIER_ORDER = 'provider-tier-order';
export const PROVIDER_TIER_HIGH = 'provider-tier-slot:high';
export const providerTierListId = (tierId: string): string => `provider-tier-list:${tierId}`;
export const providerTierAfterListId = (tierId: string): string => `provider-tier-slot:after:${tierId}`;

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
  const extra = distribute(
    total - weights.length,
    weights.map((weight) => Math.max(1, weight)),
  );
  return base.map((value, index) => value + (extra[index] ?? 0));
};

const normalizedItems = (items: readonly ProviderRoutingBoardItem[]): ProviderRoutingBoardItem[] => {
  const weights = positiveDistribution(
    ROUTING_VALUE_MAX,
    items.map((item) => item.weight),
  );
  return items.map((item, index) => ({ ...item, weight: weights[index] ?? 1 }));
};

export const buildProviderRoutingBoard = (providers: readonly DashboardProviderSummary[]): ProviderRoutingBoard => {
  const routable = providers.filter((provider) => provider.kind !== 'invalid');
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

export const providerRoutingLists = (board: ProviderRoutingBoard): Record<string, string[]> => ({
  [PROVIDER_TIER_ORDER]: board.tiers.map((tier) => tier.id),
  [PROVIDER_TIER_HIGH]: [],
  ...Object.fromEntries(
    board.tiers.flatMap((tier) => [
      [providerTierListId(tier.id), tier.items.map((item) => item.providerId)],
      [providerTierAfterListId(tier.id), []],
    ]),
  ),
});

export const providerTierPercentages = (tier: ProviderRoutingBoardTier): ReadonlyMap<string, number> => {
  const percentages = distribute(
    100,
    tier.items.map((item) => item.weight),
  );
  return new Map(tier.items.map((item, index) => [item.providerId, percentages[index] ?? 0]));
};

export const applyProviderTierOrder = (
  board: ProviderRoutingBoard,
  tierIds: readonly string[],
): ProviderRoutingBoard => {
  const byId = new Map(board.tiers.map((tier) => [tier.id, tier]));
  return { tiers: tierIds.flatMap((id) => (byId.get(id) === undefined ? [] : [byId.get(id)!])) };
};

export const applyProviderMove = (
  board: ProviderRoutingBoard,
  lists: Readonly<Record<string, readonly string[]>>,
  providerId: string,
): ProviderRoutingBoard => {
  const previousTier = board.tiers.find((tier) => tier.items.some((item) => item.providerId === providerId));
  const itemById = new Map(board.tiers.flatMap((tier) => tier.items.map((item) => [item.providerId, item] as const)));
  const order = lists[PROVIDER_TIER_ORDER] ?? board.tiers.map((tier) => tier.id);
  const tierIds = new Set(board.tiers.map((tier) => tier.id));
  let nextSequence = 1;
  const nextTierId = (): string => {
    while (tierIds.has(`tier:new:${nextSequence}`)) nextSequence += 1;
    const id = `tier:new:${nextSequence}`;
    tierIds.add(id);
    nextSequence += 1;
    return id;
  };
  const groups: Array<{ readonly id: string; readonly ids: readonly string[] }> = [];
  const high = lists[PROVIDER_TIER_HIGH] ?? [];
  if (high.length > 0) groups.push({ id: nextTierId(), ids: high });
  for (const id of order) {
    const tier = lists[providerTierListId(id)] ?? [];
    if (tier.length > 0) groups.push({ id, ids: tier });
    const after = lists[providerTierAfterListId(id)] ?? [];
    if (after.length > 0) groups.push({ id: nextTierId(), ids: after });
  }
  const targetTierId = groups.find((group) => group.ids.includes(providerId))?.id;
  if (previousTier === undefined || targetTierId === undefined) return board;

  const movedAcrossTiers = previousTier.id !== targetTierId;
  const tiers = groups.flatMap(({ id, ids }) => {
    let items = ids.flatMap((memberId) => (itemById.get(memberId) === undefined ? [] : [itemById.get(memberId)!]));
    if (movedAcrossTiers && (id === previousTier.id || id === targetTierId)) {
      items = normalizedItems(items);
    }
    if (movedAcrossTiers && id === targetTierId) {
      const equal = positiveDistribution(
        ROUTING_VALUE_MAX,
        items.map(() => 1),
      );
      items = items.map((item, index) => ({ ...item, weight: equal[index] ?? 1 }));
    }
    return [{ id, items }];
  });
  return { tiers };
};

export const applyProviderShare = (
  board: ProviderRoutingBoard,
  tierId: string,
  providerId: string,
  percentage: number,
): ProviderRoutingBoard => ({
  tiers: board.tiers.map((tier) => {
    if (tier.id !== tierId || tier.items.length < 2) return tier;
    const others = tier.items.filter((item) => item.providerId !== providerId);
    const selected = Math.min(100 - others.length, Math.max(1, Math.round(percentage)));
    const remaining = positiveDistribution(
      (100 - selected) * 100,
      others.map((item) => item.weight),
    );
    return {
      ...tier,
      items: tier.items.map((item) => {
        if (item.providerId === providerId) return { ...item, weight: selected * 100 };
        const index = others.findIndex((other) => other.providerId === item.providerId);
        return { ...item, weight: remaining[index] ?? 1 };
      }),
    };
  }),
});

export const providerRoutingMutation = (
  board: ProviderRoutingBoard,
  revision: string,
): DashboardProviderRoutingMutation => {
  const occupied = board.tiers.filter((tier) => tier.items.length > 0);
  return {
    revision,
    providers: Object.fromEntries(
      occupied.flatMap((tier, index) => {
        const priority = Math.min(ROUTING_VALUE_MAX, (occupied.length - index) * 10);
        return tier.items.map((item) => [item.providerId, { priority, weight: Math.max(1, item.weight) }]);
      }),
    ),
  };
};
