export interface WeightedTierLayout {
  readonly tiers: readonly { readonly id: string; readonly itemIds: readonly string[] }[];
  readonly parking: Readonly<Record<string, readonly string[]>>;
}

export type WeightedTierOperation = { readonly type: 'item' | 'tier'; readonly id: string };
export type WeightedTierLists = Record<string, string[]>;

export const WEIGHTED_TIER_ORDER = 'weighted-tier:order';
export const WEIGHTED_TIER_HIGH = 'weighted-tier:slot:high';

const TIER_SORTABLE_PREFIX = 'weighted-tier:tier:';

/**
 * The dnd-kit sortable id of a tier.
 *
 * Tiers and items register in one `DragDropProvider`, so a domain tier ID that happens to equal an
 * item ID — a Provider called `tier:10` against the tier generated for priority 10 — would have both
 * register the same sortable id and shadow each other. The namespace keeps them distinct; callers
 * translate back with `weightedTierIdFromSortable` before emitting a domain operation.
 */
export const weightedTierSortableId = (tierId: string): string => `${TIER_SORTABLE_PREFIX}${tierId}`;

export const weightedTierIdFromSortable = (sortableId: string): string | undefined =>
  sortableId.startsWith(TIER_SORTABLE_PREFIX) ? sortableId.slice(TIER_SORTABLE_PREFIX.length) : undefined;

export const weightedTierListId = (tierId: string): string => `weighted-tier:items:${tierId}`;
export const weightedTierAfterSlotId = (tierId: string): string => `weighted-tier:slot:after:${tierId}`;
export const weightedTierParkingId = (parkingId: string): string => `weighted-tier:parking:${parkingId}`;

export const weightedTierLists = (layout: WeightedTierLayout): WeightedTierLists => {
  const lists: WeightedTierLists = {
    [WEIGHTED_TIER_ORDER]: layout.tiers.map((tier) => weightedTierSortableId(tier.id)),
    [WEIGHTED_TIER_HIGH]: [],
  };
  for (const tier of layout.tiers) {
    lists[weightedTierListId(tier.id)] = [...tier.itemIds];
    lists[weightedTierAfterSlotId(tier.id)] = [];
  }
  for (const [id, itemIds] of Object.entries(layout.parking)) {
    lists[weightedTierParkingId(id)] = [...itemIds];
  }
  return lists;
};

const sameIds = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

const sameLayout = (left: WeightedTierLayout, right: WeightedTierLayout): boolean =>
  left.tiers.length === right.tiers.length &&
  left.tiers.every(
    (tier, index) => tier.id === right.tiers[index]?.id && sameIds(tier.itemIds, right.tiers[index]?.itemIds ?? []),
  ) &&
  Object.keys(left.parking).length === Object.keys(right.parking).length &&
  Object.entries(left.parking).every(([id, itemIds]) => sameIds(itemIds, right.parking[id] ?? []));

// The order list is kept in dnd-kit's namespaced id space; every projection compares domain ids.
const tierOrder = (lists: Readonly<Record<string, readonly string[]>>): string[] =>
  (lists[WEIGHTED_TIER_ORDER] ?? []).flatMap((id) => {
    const tierId = weightedTierIdFromSortable(id);
    return tierId === undefined ? [] : [tierId];
  });

const projectTier = (
  layout: WeightedTierLayout,
  lists: Readonly<Record<string, readonly string[]>>,
  tierId: string,
): WeightedTierLayout => {
  const byId = new Map(layout.tiers.map((tier) => [tier.id, tier]));
  if (!byId.has(tierId)) return layout;

  const remaining = tierOrder(lists).filter((id) => id !== tierId);
  const expected = layout.tiers.map((tier) => tier.id).filter((id) => id !== tierId);
  if (remaining.length !== expected.length || expected.some((id) => !remaining.includes(id))) return layout;

  const sortableId = weightedTierSortableId(tierId);
  let targetIndex = (lists[WEIGHTED_TIER_HIGH] ?? []).includes(sortableId) ? 0 : -1;
  if (targetIndex === -1) {
    const anchor = layout.tiers.find((tier) => (lists[weightedTierAfterSlotId(tier.id)] ?? []).includes(sortableId));
    if (anchor === undefined || anchor.id === tierId) return layout;
    const anchorIndex = remaining.indexOf(anchor.id);
    if (anchorIndex === -1) return layout;
    targetIndex = anchorIndex + 1;
  }

  const order = [...remaining];
  order.splice(targetIndex, 0, tierId);
  const next: WeightedTierLayout = {
    tiers: order.flatMap((id) => (byId.get(id) === undefined ? [] : [byId.get(id)!])),
    parking: layout.parking,
  };
  return sameLayout(layout, next) ? layout : next;
};

const nextTierId = (used: Set<string>): string => {
  let sequence = 1;
  while (used.has(`tier:new:${sequence}`)) sequence += 1;
  const id = `tier:new:${sequence}`;
  used.add(id);
  return id;
};

const projectItem = (
  layout: WeightedTierLayout,
  lists: Readonly<Record<string, readonly string[]>>,
  itemId: string,
): WeightedTierLayout => {
  const previousItemIds = [...layout.tiers.flatMap((tier) => tier.itemIds), ...Object.values(layout.parking).flat()];
  if (!previousItemIds.includes(itemId)) return layout;

  const order = tierOrder(lists);
  const expectedOrder = layout.tiers.map((tier) => tier.id);
  if (!sameIds(order, expectedOrder)) return layout;

  const usedTierIds = new Set(expectedOrder);
  const tiers: Array<{ readonly id: string; readonly itemIds: readonly string[] }> = [];
  const addNewTier = (itemIds: readonly string[]) => {
    if (itemIds.length > 0) tiers.push({ id: nextTierId(usedTierIds), itemIds: [...itemIds] });
  };

  addNewTier(lists[WEIGHTED_TIER_HIGH] ?? []);
  for (const tier of layout.tiers) {
    const itemIds = lists[weightedTierListId(tier.id)] ?? [];
    if (itemIds.length > 0) tiers.push({ id: tier.id, itemIds: [...itemIds] });
    addNewTier(lists[weightedTierAfterSlotId(tier.id)] ?? []);
  }

  const parking = Object.fromEntries(
    Object.keys(layout.parking).map((id) => [id, [...(lists[weightedTierParkingId(id)] ?? [])]]),
  );
  const nextItemIds = [...tiers.flatMap((tier) => tier.itemIds), ...Object.values(parking).flat()];
  if (
    nextItemIds.length !== previousItemIds.length ||
    new Set(nextItemIds).size !== nextItemIds.length ||
    previousItemIds.some((id) => !nextItemIds.includes(id))
  ) {
    return layout;
  }

  const next = { tiers, parking };
  return sameLayout(layout, next) ? layout : next;
};

export const projectWeightedTierLayout = (
  layout: WeightedTierLayout,
  lists: Readonly<Record<string, readonly string[]>>,
  operation: WeightedTierOperation,
): WeightedTierLayout =>
  operation.type === 'tier' ? projectTier(layout, lists, operation.id) : projectItem(layout, lists, operation.id);
