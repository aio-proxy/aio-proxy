import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import type { WeightedTierLayout } from '@/lib/weighted-tier-layout';

import { providerStub } from '../provider-fixtures';
import {
  applyProviderRoutingLayout,
  applyProviderShare,
  buildProviderRoutingBoard,
  providerRoutingMutation,
  providerTierPercentages,
} from './provider-routing-board';

const providers = [
  providerStub({ id: 'a', kind: ProviderKind.Api, priority: 20, weight: 1 }),
  providerStub({ id: 'b', kind: ProviderKind.Api, priority: 20, weight: 1 }),
  providerStub({ id: 'c', kind: ProviderKind.Api, priority: 20, weight: 1 }),
  providerStub({ id: 'd', kind: ProviderKind.Api, priority: 10, weight: 1 }),
];

test('a normalized tier move preserves every Provider member and weight', () => {
  const board = buildProviderRoutingBoard(providers);
  const layout: WeightedTierLayout = {
    tiers: [...board.tiers]
      .reverse()
      .map((tier) => ({ id: tier.id, itemIds: tier.items.map((item) => item.providerId) })),
    parking: {},
  };

  expect(applyProviderRoutingLayout(board, layout, { type: 'tier', id: 'tier:10' })).toEqual({
    tiers: [...board.tiers].reverse(),
  });
});

test('groups Providers by descending priority and distributes displayed percentages to exactly 100', () => {
  const board = buildProviderRoutingBoard(providers);
  expect(board.tiers.map((tier) => tier.items.map((item) => item.providerId))).toEqual([['a', 'b', 'c'], ['d']]);
  expect([...providerTierPercentages(board.tiers[0]!).values()]).toEqual([34, 33, 33]);
  expect([...providerTierPercentages(board.tiers[1]!).values()]).toEqual([100]);
});

test('changing one share keeps the tier total at 100 percent', () => {
  const board = applyProviderShare(buildProviderRoutingBoard(providers), 'tier:20', 'a', 60);
  expect([...providerTierPercentages(board.tiers[0]!).values()]).toEqual([60, 20, 20]);
});

test('clamps a share so every other Provider retains at least one percent', () => {
  const board = applyProviderShare(buildProviderRoutingBoard(providers), 'tier:20', 'a', 100);
  expect([...providerTierPercentages(board.tiers[0]!).values()]).toEqual([98, 1, 1]);
});

test('moving a Provider rebalances both tiers and removes an empty source tier', () => {
  const board = buildProviderRoutingBoard(providers);
  const next = applyProviderRoutingLayout(
    board,
    {
      tiers: [{ id: 'tier:20', itemIds: ['a', 'b', 'c', 'd'] }],
      parking: {},
    },
    { type: 'item', id: 'd' },
  );
  expect(next.tiers).toHaveLength(1);
  expect([...providerTierPercentages(next.tiers[0]!).values()]).toEqual([25, 25, 25, 25]);
});

test.each([
  [
    [
      { id: 'tier:new:1', itemIds: ['a'] },
      { id: 'tier:20', itemIds: ['b', 'c'] },
      { id: 'tier:10', itemIds: ['d'] },
    ],
    [['a'], ['b', 'c'], ['d']],
  ],
  [
    [
      { id: 'tier:20', itemIds: ['b', 'c'] },
      { id: 'tier:new:1', itemIds: ['a'] },
      { id: 'tier:10', itemIds: ['d'] },
    ],
    [['b', 'c'], ['a'], ['d']],
  ],
  [
    [
      { id: 'tier:20', itemIds: ['b', 'c'] },
      { id: 'tier:10', itemIds: ['d'] },
      { id: 'tier:new:1', itemIds: ['a'] },
    ],
    [['b', 'c'], ['d'], ['a']],
  ],
] as const)('dropping a Provider into a tier insertion slot creates a tier at that position', (tiers, expected) => {
  const board = buildProviderRoutingBoard(providers);
  const next = applyProviderRoutingLayout(board, { tiers, parking: {} }, { type: 'item', id: 'a' });
  expect(next.tiers.map((tier) => tier.items.map((item) => item.providerId))).toEqual(expected);
  expect([...providerTierPercentages(next.tiers.find((tier) => tier.items[0]?.providerId === 'a')!).values()]).toEqual([
    100,
  ]);
});

test('tier order becomes compact descending priorities in the mutation', () => {
  const board = buildProviderRoutingBoard(providers);
  const reversed = { tiers: [...board.tiers].reverse() };
  expect(providerRoutingMutation(reversed, 'revision').providers).toEqual({
    d: { priority: 20, weight: 1 },
    a: { priority: 10, weight: 1 },
    b: { priority: 10, weight: 1 },
    c: { priority: 10, weight: 1 },
  });
});

test('a share-only edit commits the priorities the board already carried', () => {
  // Recompacting would be visible past this board: an exact model override is absolute, so lifting
  // two Providers that both sit at 0 to 20 and 10 flips their order against an override pinning one
  // of them at 5. Only a layout change may rewrite priorities.
  const flat = [
    providerStub({ id: 'a', kind: ProviderKind.Api, priority: 0, weight: 1 }),
    providerStub({ id: 'b', kind: ProviderKind.Api, priority: 0, weight: 1 }),
  ];
  const board = applyProviderShare(buildProviderRoutingBoard(flat), 'tier:0', 'a', 70);

  expect(providerRoutingMutation(board, 'revision').providers).toEqual({
    a: { priority: 0, weight: 7000 },
    b: { priority: 0, weight: 3000 },
  });
});

test('reordering tiers still recompacts, since the moved tier no longer matches its encoded priority', () => {
  const flat = [
    providerStub({ id: 'a', kind: ProviderKind.Api, priority: 20, weight: 1 }),
    providerStub({ id: 'b', kind: ProviderKind.Api, priority: 10, weight: 1 }),
  ];
  const board = buildProviderRoutingBoard(flat);

  expect(providerRoutingMutation({ tiers: [...board.tiers].reverse() }, 'revision').providers).toEqual({
    b: { priority: 20, weight: 1 },
    a: { priority: 10, weight: 1 },
  });
});

test('every occupied tier keeps a distinct priority past the ten-point spacing limit', () => {
  const many = Array.from({ length: 1001 }, (_, index) =>
    providerStub({ id: `p${index}`, kind: ProviderKind.Api, priority: index + 1, weight: 1 }),
  );
  const priorities = Object.values(providerRoutingMutation(buildProviderRoutingBoard(many), 'revision').providers).map(
    (routing) => routing.priority,
  );

  expect(priorities).toHaveLength(1001);
  expect(new Set(priorities).size).toBe(1001);
  expect(Math.max(...priorities)).toBeLessThanOrEqual(10_000);
});

test('a zero-weight Provider stays parked when an unrelated tier is reordered', () => {
  const parked = [...providers, providerStub({ id: 'e', kind: ProviderKind.Api, priority: 20, weight: 0 })];
  const board = buildProviderRoutingBoard(parked);
  const reversed = { tiers: [...board.tiers].reverse() };

  expect(providerRoutingMutation(reversed, 'revision').providers['e']).toEqual({ priority: 10, weight: 0 });
});

test('a parked Provider holds no share and does not dilute its tier', () => {
  const parked = [...providers, providerStub({ id: 'e', kind: ProviderKind.Api, priority: 10, weight: 0 })];
  const tier = buildProviderRoutingBoard(parked).tiers[1]!;

  expect([...providerTierPercentages(tier)]).toEqual([
    ['d', 100],
    ['e', 0],
  ]);
});

test('moving a Provider into a tier leaves a parked member of that tier at zero', () => {
  const parked = [...providers, providerStub({ id: 'e', kind: ProviderKind.Api, priority: 10, weight: 0 })];
  const board = buildProviderRoutingBoard(parked);
  const next = applyProviderRoutingLayout(
    board,
    {
      tiers: [
        { id: 'tier:20', itemIds: ['b', 'c'] },
        { id: 'tier:10', itemIds: ['d', 'e', 'a'] },
      ],
      parking: {},
    },
    { type: 'item', id: 'a' },
  );

  expect(next.tiers[1]!.items.find((item) => item.providerId === 'e')?.weight).toBe(0);
  expect([...providerTierPercentages(next.tiers[1]!)]).toEqual([
    ['d', 50],
    ['e', 0],
    ['a', 50],
  ]);
});

test('a share edit never revives a parked Provider it is splitting against', () => {
  const parked = [
    providerStub({ id: 'a', kind: ProviderKind.Api, priority: 20, weight: 5000 }),
    providerStub({ id: 'b', kind: ProviderKind.Api, priority: 20, weight: 0 }),
  ];
  const tier = applyProviderShare(buildProviderRoutingBoard(parked), 'tier:20', 'a', 40).tiers[0]!;

  expect(tier.items.find((item) => item.providerId === 'b')?.weight).toBe(0);
  // `a` is the only active member, so it still carries the whole tier whatever its weight became.
  expect([...providerTierPercentages(tier)]).toEqual([
    ['a', 100],
    ['b', 0],
  ]);
});

test('the only Provider in a tier can still be parked and brought back', () => {
  const single = [providerStub({ id: 'a', kind: ProviderKind.Api, priority: 20, weight: 1 })];
  const board = buildProviderRoutingBoard(single);
  const parked = applyProviderShare(board, 'tier:20', 'a', 0);

  expect(providerRoutingMutation(parked, 'revision').providers['a']?.weight).toBe(0);
  expect(providerRoutingMutation(applyProviderShare(parked, 'tier:20', 'a', 100), 'revision').providers['a']).toEqual({
    priority: 20,
    weight: 10_000,
  });
});

test('dragging a parked Provider into another tier is the interaction that unparks it', () => {
  const parked = [...providers, providerStub({ id: 'e', kind: ProviderKind.Api, priority: 10, weight: 0 })];
  const board = buildProviderRoutingBoard(parked);
  const next = applyProviderRoutingLayout(
    board,
    {
      tiers: [
        { id: 'tier:20', itemIds: ['a', 'b', 'c', 'e'] },
        { id: 'tier:10', itemIds: ['d'] },
      ],
      parking: {},
    },
    { type: 'item', id: 'e' },
  );

  expect(next.tiers[0]!.items.find((item) => item.providerId === 'e')?.weight).toBeGreaterThan(0);
  expect([...providerTierPercentages(next.tiers[0]!).values()]).toEqual([25, 25, 25, 25]);
});

test('a share edit in a tier larger than one hundred keeps every Provider routable', () => {
  const crowded = Array.from({ length: 101 }, (_, index) =>
    providerStub({ id: `p${index}`, kind: ProviderKind.Api, priority: 20, weight: 1 }),
  );
  const tier = applyProviderShare(buildProviderRoutingBoard(crowded), 'tier:20', 'p0', 50).tiers[0]!;

  expect(tier.items.every((item) => item.weight > 0)).toBe(true);
  expect(tier.items.find((item) => item.providerId === 'p0')?.weight).toBe(5000);
});

test('a zero share parks a Provider, and raising it again brings it back', () => {
  const board = buildProviderRoutingBoard(providers);
  const parked = applyProviderShare(board, 'tier:20', 'a', 0);

  expect(parked.tiers[0]!.items.find((item) => item.providerId === 'a')?.weight).toBe(0);
  expect(providerRoutingMutation(parked, 'revision').providers['a']?.weight).toBe(0);
  expect(
    applyProviderShare(parked, 'tier:20', 'a', 60).tiers[0]!.items.find((item) => item.providerId === 'a')?.weight,
  ).toBeGreaterThan(0);
});

test('a completely packed board still gives every tier a distinct priority', () => {
  const many = Array.from({ length: 10_001 }, (_, index) =>
    providerStub({ id: `p${index}`, kind: ProviderKind.Api, priority: index + 1, weight: 1 }),
  );
  const priorities = Object.values(providerRoutingMutation(buildProviderRoutingBoard(many), 'revision').providers).map(
    (routing) => routing.priority,
  );

  expect(new Set(priorities).size).toBe(10_001);
  expect(Math.max(...priorities)).toBe(10_000);
  expect(Math.min(...priorities)).toBe(0);
});

test('a Provider whose configuration failed to parse is not routable even when its kind survived', () => {
  const degraded = providerStub({
    id: 'broken',
    kind: ProviderKind.Api,
    priority: 20,
    state: {
      status: 'unavailable',
      diagnostic: {
        code: 'PROVIDER_CONFIG_INVALID',
        summary: 'invalid',
        retryable: false,
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    },
  });
  const board = buildProviderRoutingBoard([...providers, degraded]);

  expect(board.tiers.flatMap((tier) => tier.items.map((item) => item.providerId))).not.toContain('broken');
  expect(providerRoutingMutation(board, 'revision').providers['broken']).toBeUndefined();
});
