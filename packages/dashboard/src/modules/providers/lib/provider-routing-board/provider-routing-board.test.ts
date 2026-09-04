import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { providerStub } from '../provider-fixtures';
import {
  applyProviderMove,
  applyProviderShare,
  buildProviderRoutingBoard,
  PROVIDER_TIER_HIGH,
  PROVIDER_TIER_ORDER,
  providerTierAfterListId,
  providerRoutingLists,
  providerRoutingMutation,
  providerTierListId,
  providerTierPercentages,
} from './provider-routing-board';

const providers = [
  providerStub({ id: 'a', kind: ProviderKind.Api, priority: 20, weight: 1 }),
  providerStub({ id: 'b', kind: ProviderKind.Api, priority: 20, weight: 1 }),
  providerStub({ id: 'c', kind: ProviderKind.Api, priority: 20, weight: 1 }),
  providerStub({ id: 'd', kind: ProviderKind.Api, priority: 10, weight: 1 }),
];

test('groups Providers by descending priority and distributes displayed percentages to exactly 100', () => {
  const board = buildProviderRoutingBoard(providers);
  expect(board.tiers.map((tier) => tier.items.map((item) => item.providerId))).toEqual([['a', 'b', 'c'], ['d']]);
  expect([...providerTierPercentages(board.tiers[0]!).values()]).toEqual([34, 33, 33]);
  expect([...providerTierPercentages(board.tiers[1]!).values()]).toEqual([100]);
});

test('uses distinct list IDs so tier sorting and Provider drop targets cannot collide', () => {
  const lists = providerRoutingLists(buildProviderRoutingBoard(providers));

  expect(lists['tier:20']).toBeUndefined();
  expect(lists[providerTierListId('tier:20')]).toEqual(['a', 'b', 'c']);
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
  const lists = providerRoutingLists(board);
  const next = applyProviderMove(
    board,
    {
      ...lists,
      [PROVIDER_TIER_ORDER]: ['tier:20', 'tier:10'],
      [providerTierListId('tier:20')]: ['a', 'b', 'c', 'd'],
      [providerTierListId('tier:10')]: [],
    },
    'd',
  );
  expect(next.tiers).toHaveLength(1);
  expect([...providerTierPercentages(next.tiers[0]!).values()]).toEqual([25, 25, 25, 25]);
});

test.each([
  [PROVIDER_TIER_HIGH, [['a'], ['b', 'c'], ['d']]],
  [providerTierAfterListId('tier:20'), [['b', 'c'], ['a'], ['d']]],
  [providerTierAfterListId('tier:10'), [['b', 'c'], ['d'], ['a']]],
] as const)('dropping a Provider into %s creates a tier at that position', (slotId, expected) => {
  const board = buildProviderRoutingBoard(providers);
  const lists = providerRoutingLists(board);
  const next = applyProviderMove(
    board,
    {
      ...lists,
      [providerTierListId('tier:20')]: ['b', 'c'],
      [slotId]: ['a'],
    },
    'a',
  );
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
