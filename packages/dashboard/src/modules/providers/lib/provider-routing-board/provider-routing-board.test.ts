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
