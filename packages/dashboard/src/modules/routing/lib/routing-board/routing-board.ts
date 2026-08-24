import type { DashboardRoutingProvider } from '@aio-proxy/types';
import { ROUTING_VALUE_MAX } from '@aio-proxy/types';

import { buildRoutingTiers, effectiveRoutingCandidates, type RoutingProviderDraft } from '../routing-summary';

export const ROUTING_BOARD_UNUSED = 'unused';
export const ROUTING_BOARD_HIGH = 'slot:high';

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
};

export type RoutingBoard = {
  readonly tiers: readonly { readonly priority: number; readonly items: readonly RoutingBoardItem[] }[];
  readonly unused: readonly RoutingBoardItem[];
  readonly blocked: readonly RoutingBoardItem[];
};

export type RoutingBoardLists = Record<string, string[]>;

export const routingBoardTierListId = (priority: number): string => `tier:${priority}`;
export const routingBoardAfterListId = (priority: number): string => `slot:after:${priority}`;

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

const listOf = (providerId: string, lists: Readonly<Record<string, readonly string[]>>): string | undefined =>
  Object.keys(lists).find((key) => lists[key]?.includes(providerId));

const tierPriorities = (lists: Readonly<Record<string, readonly string[]>>): number[] =>
  Object.keys(lists)
    .flatMap((key) => {
      const match = TIER_LIST.exec(key);
      return match === null ? [] : [Number(match[1])];
    })
    .sort((left, right) => right - left);

const sameMembers = (left: readonly string[], right: readonly string[]): boolean => {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((id) => seen.has(id));
};

export const sameListMembership = (
  left: Readonly<Record<string, readonly string[]>>,
  right: Readonly<Record<string, readonly string[]>>,
): boolean => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => sameMembers(left[key] ?? [], right[key] ?? []));
};

export const listsFromBoard = (board: RoutingBoard): RoutingBoardLists => {
  const lists: RoutingBoardLists = {
    [ROUTING_BOARD_HIGH]: [],
    [ROUTING_BOARD_UNUSED]: board.unused.map((item) => item.providerId),
  };
  for (const tier of board.tiers) {
    lists[routingBoardTierListId(tier.priority)] = tier.items.map((item) => item.providerId);
    lists[routingBoardAfterListId(tier.priority)] = [];
  }
  return lists;
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
    })),
  }));
  const unused: RoutingBoardItem[] = [];
  const blocked: RoutingBoardItem[] = [];
  for (const provider of providers) {
    if (byId.get(provider.id)?.eligible === true) continue;
    const item = { providerId: provider.id, draggable: isReady(provider), share: null };
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

const activeGroups = (lists: Readonly<Record<string, readonly string[]>>): ActiveGroup[] => {
  const groups: ActiveGroup[] = [];
  const high = lists[ROUTING_BOARD_HIGH] ?? [];
  if (high.length > 0) groups.push({ ids: high });
  for (const priority of tierPriorities(lists)) {
    const tier = lists[routingBoardTierListId(priority)] ?? [];
    if (tier.length > 0) groups.push({ ids: tier, keep: priority });
    const inserted = lists[routingBoardAfterListId(priority)] ?? [];
    if (inserted.length > 0) groups.push({ ids: inserted });
  }
  return groups;
};

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

export const applyRoutingBoardMove = ({
  providers,
  previousRows,
  previousLists,
  nextLists,
}: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly previousRows: readonly RoutingBoardDraftRow[];
  readonly previousLists: Readonly<Record<string, readonly string[]>>;
  readonly nextLists: Readonly<Record<string, readonly string[]>>;
}): RoutingBoardDraftRow[] => {
  const previousById = new Map(previousRows.map((row) => [row.providerId, row]));
  const previousEffective = new Map(
    effectiveRoutingCandidates(providers, draftRecord(previousRows)).map((candidate) => [
      candidate.providerId,
      candidate,
    ]),
  );
  const weights = new Map<string, number>();
  for (const provider of providers) {
    const from = listOf(provider.id, previousLists);
    const to = listOf(provider.id, nextLists);
    if (to === undefined || to === ROUTING_BOARD_UNUSED) continue;
    const current = previousEffective.get(provider.id)?.weight ?? provider.defaults.weight.effective;
    if (current > 0) {
      weights.set(provider.id, current);
      continue;
    }
    const restored = provider.defaults.weight.effective > 0 ? provider.defaults.weight.effective : 1;
    weights.set(provider.id, from === to ? current : restored);
  }
  const groups = activeGroups(nextLists);
  const priorities = assignGroupPriorities(groups);
  const assignedPriority = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const id of group.ids) assignedPriority.set(id, priorities[index] ?? 0);
  });
  return providers.map((provider) => {
    const to = listOf(provider.id, nextLists);
    if (to === undefined) return previousById.get(provider.id) ?? { providerId: provider.id };
    if (to === ROUTING_BOARD_UNUSED) {
      return omitDefault(provider, previousById.get(provider.id)?.priority, 0);
    }
    return omitDefault(provider, assignedPriority.get(provider.id), weights.get(provider.id));
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

export const applyRoutingShare = ({
  providers,
  rows,
  memberIds,
  providerId,
  percent,
}: {
  readonly providers: readonly DashboardRoutingProvider[];
  readonly rows: readonly RoutingBoardDraftRow[];
  readonly memberIds: readonly string[];
  readonly providerId: string;
  readonly percent: number;
}): RoutingBoardDraftRow[] => {
  const previousById = new Map(rows.map((row) => [row.providerId, row]));
  const effective = new Map(
    effectiveRoutingCandidates(providers, draftRecord(rows)).map((candidate) => [candidate.providerId, candidate]),
  );
  const clamped = Math.min(99, Math.max(1, Math.round(percent)));
  const others = memberIds.filter((id) => id !== providerId);
  const otherWeights = others.map((id) => {
    const weight = effective.get(id)?.weight ?? 0;
    return weight > 0 ? weight : 1;
  });
  const otherTotal = otherWeights.reduce((sum, weight) => sum + weight, 0);
  const remaining = 100 - clamped;
  const distributed = distributeRemainder(remaining, otherTotal === 0 ? others.map(() => 1) : otherWeights);
  const nextWeights = new Map<string, number>([[providerId, clamped]]);
  others.forEach((id, index) => {
    nextWeights.set(id, distributed[index] ?? 0);
  });
  return providers.map((provider) => {
    const weight = nextWeights.get(provider.id);
    if (weight === undefined) return previousById.get(provider.id) ?? { providerId: provider.id };
    return omitDefault(provider, previousById.get(provider.id)?.priority, weight);
  });
};
