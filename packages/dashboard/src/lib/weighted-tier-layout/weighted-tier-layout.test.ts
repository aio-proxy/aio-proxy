import { expect, test } from '@rstest/core';

import {
  WEIGHTED_TIER_HIGH,
  WEIGHTED_TIER_ORDER,
  projectWeightedTierLayout,
  weightedTierAfterSlotId,
  weightedTierListId,
  weightedTierLists,
  weightedTierParkingId,
  type WeightedTierLayout,
} from './weighted-tier-layout';

const layout = (): WeightedTierLayout => ({
  tiers: [
    { id: 'high', itemIds: ['a', 'd'] },
    { id: 'low', itemIds: ['b'] },
  ],
  parking: { unused: ['c'] },
});

test('an item dropped between tiers becomes a new tier at that position', () => {
  const previous = layout();
  const lists = {
    ...weightedTierLists(previous),
    [weightedTierListId('high')]: ['d'],
    [weightedTierAfterSlotId('high')]: ['a'],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'item', id: 'a' })).toEqual({
    tiers: [
      { id: 'high', itemIds: ['d'] },
      { id: 'tier:new:1', itemIds: ['a'] },
      { id: 'low', itemIds: ['b'] },
    ],
    parking: { unused: ['c'] },
  });
});

test('a tier dropped into the highest slot moves all members together', () => {
  const previous = layout();
  const lists = {
    ...weightedTierLists(previous),
    [WEIGHTED_TIER_ORDER]: ['high'],
    [WEIGHTED_TIER_HIGH]: ['low'],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'tier', id: 'low' })).toEqual({
    tiers: [
      { id: 'low', itemIds: ['b'] },
      { id: 'high', itemIds: ['a', 'd'] },
    ],
    parking: { unused: ['c'] },
  });
});

test('an item can move from an active tier into a parking list', () => {
  const previous = layout();
  const lists = {
    ...weightedTierLists(previous),
    [weightedTierListId('low')]: [],
    [weightedTierParkingId('unused')]: ['c', 'b'],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'item', id: 'b' })).toEqual({
    tiers: [{ id: 'high', itemIds: ['a', 'd'] }],
    parking: { unused: ['c', 'b'] },
  });
});

test('an invalid tier destination leaves the layout unchanged', () => {
  const previous = layout();
  const lists = {
    ...weightedTierLists(previous),
    [WEIGHTED_TIER_ORDER]: ['high'],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'tier', id: 'low' })).toBe(previous);
});

test('new tier IDs skip IDs already present in the board', () => {
  const previous: WeightedTierLayout = {
    tiers: [
      { id: 'tier:new:1', itemIds: ['a', 'd'] },
      { id: 'low', itemIds: ['b'] },
    ],
    parking: {},
  };
  const lists = {
    ...weightedTierLists(previous),
    [weightedTierListId('tier:new:1')]: ['d'],
    [weightedTierAfterSlotId('tier:new:1')]: ['a'],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'item', id: 'a' }).tiers[1]?.id).toBe('tier:new:2');
});
