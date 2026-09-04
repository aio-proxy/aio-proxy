import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { ROUTING_VALUE_MAX } from '@aio-proxy/types';

import type { WeightedTierLayout, WeightedTierOperation } from '@/lib/weighted-tier-layout';

import { buildRoutingTiers, effectiveRoutingCandidates, type RoutingProviderDraft } from '../routing-summary';

const TIER_LIST = /^tier:(\d+)$/;

export type RoutingBoardDraftRow = {
  providerId: string;
  priority?: number;
  weight?: number;
};

export type RoutingBoardItem = {
  readonly providerId: string;
  readonly draggable: boolean;
  readonly share: number | null;
  readonly weight: number;
};

export type RoutingBoard = {
  readonly tiers: readonly { readonly priority: number; readonly items: readonly RoutingBoardItem[] }[];
  readonly unused: readonly RoutingBoardItem[];
  readonly blocked: readonly RoutingBoardItem[];
};

const draftRecord = (rows: readonly RoutingBoardDraftRow[]): Record<string, RoutingProviderDraft> =>
  Object.fromEntries(
    rows.map((row) => [
      row.providerId,
      {
        ...(row.priority === undefined ? {} : { priority: row.priority }),
        ...(row.weight === undefined ? {} : { weight: row.weight }),
      },
    ]),
  );

const isReady = (provider: DashboardRoutingProvider): boolean => provider.enabled && provider.state.status === 'ready';

const sameMembers = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((id) => seen.has(id));
};

export const buildRoutingBoard = (
  providers: readonly DashboardRoutingProvider[],
  rows: readonly RoutingBoardDraftRow[],
): RoutingBoard => {
  const candidates = effectiveRoutingCandidates(providers, draftRecord(rows));
  const byId = new Map(candidates.map((candidate) => [candidate.providerId, candidate]));
  const tiers = buildRoutingTiers(candidates).map((tier) => ({
    priority: tier.priority,
    items: tier.providers.map((entry) => ({
      providerId: entry.providerId,
      draggable: true,
      share: entry.share,
      weight: entry.weight,
    })),
  }));
  const unused: RoutingBoardItem[] = [];
  const blocked: RoutingBoardItem[] = [];
  for (const provider of providers) {
    if (byId.get(provider.id)?.eligible === true) continue;
    const item = {
      providerId: provider.id,
      draggable: isReady(provider),
      share: null,
      weight: byId.get(provider.id)?.weight ?? provider.defaults.weight.effective,
    };
    if (item.draggable) unused.push(item);
    else blocked.push(item);
  }
  return { tiers, unused, blocked };
};

const allocatePriority = (higher: number | undefined, lower: number | undefined): number | undefined => {
  if (higher === undefined && lower === undefined) return 10;
  if (higher === undefined)
    return lower !== undefined && lower < ROUTING_VALUE_MAX ? Math.min(ROUTING_VALUE_MAX, lower + 10) : undefined;
  if (lower === undefined) return higher > 0 ? Math.max(0, higher - 10) : undefined;
  if (higher - lower <= 1) return undefined;
  return Math.floor((higher + lower) / 2);
};

const compactPriorities = (count: number): number[] => {
  if (count <= 0) return [];
  const step = count * 10 <= ROUTING_VALUE_MAX ? 10 : Math.max(1, Math.floor(ROUTING_VALUE_MAX / count));
  return Array.from({ length: count }, (_, index) => Math.min(ROUTING_VALUE_MAX, (count - index) * step));
};

type ActiveGroup = { readonly ids: readonly string[]; readonly keep?: number };

const assignGroupPriorities = (groups: readonly ActiveGroup[]): number[] => {
  const assigned: Array<number | undefined> = groups.map((group) => group.keep);
  for (let index = 0; index < groups.length; index += 1) {
    if (assigned[index] !== undefined) continue;
    const higher = [...assigned.slice(0, index)].reverse().find((value) => value !== undefined);
    const lower = assigned.slice(index + 1).find((value) => value !== undefined);
    const next = allocatePriority(higher, lower);
    if (next === undefined || assigned.includes(next)) return compactPriorities(groups.length);
    assigned[index] = next;
  }
  return assigned.map((value, index) => value ?? compactPriorities(groups.length)[index] ?? 0);
};

const omitDefault = (
  provider: DashboardRoutingProvider,
  priority: number | undefined,
  weight: number | undefined,
): RoutingBoardDraftRow => ({
  providerId: provider.id,
  ...(priority === undefined || priority === provider.defaults.priority.effective ? {} : { priority }),
  ...(weight === undefined || weight === provider.defaults.weight.effective ? {} : { weight }),
});

const layoutItemIds = (layout: WeightedTierLayout): string[] => [
  ...layout.tiers.flatMap((tier) => tier.itemIds),
  ...Object.values(layout.parking).flat(),
];

const sameParkingKeys = (left: WeightedTierLayout, right: WeightedTierLayout): boolean => {
  const keys = Object.keys(left.parking);
  return keys.length === Object.keys(right.parking).length && keys.every((key) => key in right.parking);
};

const sameParkingMembers = (left: WeightedTierLayout, right: WeightedTierLayout): boolean =>
  Object.keys(left.parking).every((key) => sameMembers(left.parking[key] ?? [], right.parking[key] ?? []));

const validLayoutTransition = (
  previous: WeightedTierLayout,
  next: WeightedTierLayout,
  operation: WeightedTierOperation,
): boolean => {
  const previousItems = layoutItemIds(previous);
  const nextItems = layoutItemIds(next);
  if (
    new Set(previousItems).size !== previousItems.length ||
    new Set(nextItems).size !== nextItems.length ||
    !sameMembers(previousItems, nextItems) ||
    !sameParkingKeys(previous, next)
  ) {
    return false;
  }
  if (operation.type === 'item') return previousItems.includes(operation.id);

  const previousById = new Map(previous.tiers.map((tier) => [tier.id, tier]));
  return (
    previousById.has(operation.id) &&
    sameParkingMembers(previous, next) &&
    previous.tiers.length === next.tiers.length &&
    next.tiers.every((tier) => {
      const before = previousById.get(tier.id);
      return before !== undefined && sameMembers(before.itemIds, tier.itemIds);
    })
  );
};

const layoutGroups = (layout: WeightedTierLayout, operation: WeightedTierOperation): ActiveGroup[] =>
  layout.tiers.map((tier) => {
    const match = TIER_LIST.exec(tier.id);
    const keep = operation.type === 'tier' && operation.id === tier.id ? undefined : Number(match?.[1]);
    return { ids: tier.itemIds, ...(Number.isFinite(keep) ? { keep } : {}) };
  });

const layoutLocation = (layout: WeightedTierLayout, providerId: string): string | undefined => {
  const tier = layout.tiers.find((entry) => entry.itemIds.includes(providerId));
  if (tier !== undefined) return `tier:${tier.id}`;
  const parking = Object.entries(layout.parking).find(([, itemIds]) => itemIds.includes(providerId));
  return parking === undefined ? undefined : `parking:${parking[0]}`;
};

export const applyRoutingBoardLayout = ({
  providers,
  previousRows,
  previousLayout,
  nextLayout,
  operation,
}: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly previousRows: readonly RoutingBoardDraftRow[];
  readonly previousLayout: WeightedTierLayout;
  readonly nextLayout: WeightedTierLayout;
  readonly operation: WeightedTierOperation;
}): RoutingBoardDraftRow[] => {
  if (!validLayoutTransition(previousLayout, nextLayout, operation)) return [...previousRows];

  const previousById = new Map(previousRows.map((row) => [row.providerId, row]));
  const previousEffective = new Map(
    effectiveRoutingCandidates(providers, draftRecord(previousRows)).map((candidate) => [
      candidate.providerId,
      candidate,
    ]),
  );
  const groups = layoutGroups(nextLayout, operation);
  const priorities = assignGroupPriorities(groups);
  const assignedPriority = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const id of group.ids) assignedPriority.set(id, priorities[index] ?? 0);
  });

  return providers.map((provider) => {
    const nextLocation = layoutLocation(nextLayout, provider.id);
    if (nextLocation === undefined) return previousById.get(provider.id) ?? { providerId: provider.id };
    if (nextLocation === 'parking:unused') {
      return omitDefault(provider, previousById.get(provider.id)?.priority, 0);
    }
    if (nextLocation.startsWith('parking:')) return previousById.get(provider.id) ?? { providerId: provider.id };

    const current = previousEffective.get(provider.id)?.weight ?? provider.defaults.weight.effective;
    const moved = layoutLocation(previousLayout, provider.id) !== nextLocation;
    const weight = current > 0 || !moved ? current : Math.max(1, provider.defaults.weight.effective);
    return omitDefault(provider, assignedPriority.get(provider.id), weight);
  });
};

const distributeRemainder = (total: number, parts: readonly number[]): number[] => {
  if (parts.length === 0) return [];
  const sum = parts.reduce((acc, part) => acc + part, 0);
  const raw = parts.map((part) => (sum === 0 ? total / parts.length : (part / sum) * total));
  const floors = raw.map((value) => Math.floor(value));
  let leftover = total - floors.reduce((acc, value) => acc + value, 0);
  const order = floors
    .map((_, index) => index)
    .sort((left, right) => {
      const delta = (raw[right] ?? 0) - (floors[right] ?? 0) - ((raw[left] ?? 0) - (floors[left] ?? 0));
      return delta !== 0 ? delta : left - right;
    });
  for (const index of order) {
    if (leftover <= 0) break;
    floors[index] = (floors[index] ?? 0) + 1;
    leftover -= 1;
  }
  return floors;
};

const allocateBounded = (total: number, parts: readonly number[]): number[] => {
  if (parts.length === 0) return [];
  const result = parts.map(() => 1);
  let remaining = total - result.length;
  let open = result.map((_, index) => index);
  while (remaining > 0 && open.length > 0) {
    const extras = distributeRemainder(
      remaining,
      open.map((index) => parts[index] ?? 1),
    );
    remaining = 0;
    const nextOpen: number[] = [];
    open.forEach((index, order) => {
      const next = (result[index] ?? 1) + (extras[order] ?? 0);
      if (next > ROUTING_VALUE_MAX) {
        remaining += next - ROUTING_VALUE_MAX;
        result[index] = ROUTING_VALUE_MAX;
        return;
      }
      result[index] = next;
      nextOpen.push(index);
    });
    if (nextOpen.length === open.length) break;
    open = nextOpen;
  }
  return result;
};

export const applyRoutingShare = ({
  providers,
  rows,
  memberIds,
  providerId,
  weight,
}: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly rows: readonly RoutingBoardDraftRow[];
  readonly memberIds: readonly string[];
  readonly providerId: string;
  readonly weight: number;
}): RoutingBoardDraftRow[] => {
  const previousById = new Map(rows.map((row) => [row.providerId, row]));
  const effective = new Map(
    effectiveRoutingCandidates(providers, draftRecord(rows)).map((candidate) => [candidate.providerId, candidate]),
  );
  const memberWeight = (id: string): number => {
    const current = effective.get(id)?.weight ?? 0;
    return current > 0 ? current : 1;
  };
  const others = memberIds.filter((id) => id !== providerId);
  const otherWeights = others.map(memberWeight);
  const otherTotal = otherWeights.reduce((sum, value) => sum + value, 0);
  const currentTotal = memberWeight(providerId) + otherTotal;
  const total = currentTotal > others.length + 1 ? currentTotal : ROUTING_VALUE_MAX;
  const selected = Math.min(Math.max(1, Math.round(weight)), Math.min(ROUTING_VALUE_MAX, total - others.length));
  const remaining = total - selected;
  const distributed = allocateBounded(remaining, otherTotal === 0 ? others.map(() => 1) : otherWeights);
  const nextWeights = new Map<string, number>([[providerId, selected]]);
  others.forEach((id, index) => {
    nextWeights.set(id, distributed[index] ?? 0);
  });
  return providers.map((provider) => {
    const weight = nextWeights.get(provider.id);
    if (weight === undefined) return previousById.get(provider.id) ?? { providerId: provider.id };
    return omitDefault(provider, previousById.get(provider.id)?.priority, weight);
  });
};
