import { expect, test } from '@rstest/core';

import {
  WEIGHTED_TIER_HIGH,
  WEIGHTED_TIER_ORDER,
  projectWeightedTierLayout,
  weightedTierAfterSlotId,
  weightedTierItemSortableId,
  weightedTierListId,
  weightedTierLists,
  weightedTierParkingId,
  weightedTierSortableId,
  type WeightedTierLayout,
} from './weighted-tier-layout';

const items = (...ids: readonly string[]): string[] => ids.map(weightedTierItemSortableId);

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
    [weightedTierListId('high')]: items('d'),
    [weightedTierAfterSlotId('high')]: items('a'),
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
    [WEIGHTED_TIER_ORDER]: [weightedTierSortableId('high')],
    [WEIGHTED_TIER_HIGH]: [weightedTierSortableId('low')],
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
    [weightedTierParkingId('unused')]: items('c', 'b'),
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
    [WEIGHTED_TIER_ORDER]: [weightedTierSortableId('high')],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'tier', id: 'low' })).toBe(previous);
});

test('a tier whose ID equals an item ID still moves independently of that item', () => {
  // Tiers and items share one dnd-kit provider, so both id spaces are namespaced. Without that, the
  // two registrations shadow each other and either drag targets the wrong sortable.
  const previous: WeightedTierLayout = {
    tiers: [
      { id: 'tier:10', itemIds: ['x'] },
      { id: 'low', itemIds: ['tier:10'] },
    ],
    parking: {},
  };
  const lists = {
    ...weightedTierLists(previous),
    [WEIGHTED_TIER_ORDER]: [weightedTierSortableId('tier:10')],
    [WEIGHTED_TIER_HIGH]: [weightedTierSortableId('low')],
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'tier', id: 'low' })).toEqual({
    tiers: [
      { id: 'low', itemIds: ['tier:10'] },
      { id: 'tier:10', itemIds: ['x'] },
    ],
    parking: {},
  });
});

test('an item whose ID collides with a generated list or tier id still moves on its own', () => {
  // Item IDs come from the caller and dnd-kit accepts any string, so one can spell a droppable list
  // id or another sortable's id. The item namespace is disjoint from both, so the projection reads
  // the list it was actually dropped into rather than a shadowed registration.
  const previous: WeightedTierLayout = {
    tiers: [
      { id: 'high', itemIds: ['weighted-tier:items:high', 'weighted-tier:tier:high'] },
      { id: 'low', itemIds: ['b'] },
    ],
    parking: {},
  };
  const lists = {
    ...weightedTierLists(previous),
    [weightedTierListId('high')]: items('weighted-tier:tier:high'),
    [weightedTierListId('low')]: items('b', 'weighted-tier:items:high'),
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'item', id: 'weighted-tier:items:high' })).toEqual({
    tiers: [
      { id: 'high', itemIds: ['weighted-tier:tier:high'] },
      { id: 'low', itemIds: ['b', 'weighted-tier:items:high'] },
    ],
    parking: {},
  });
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
    [weightedTierListId('tier:new:1')]: items('d'),
    [weightedTierAfterSlotId('tier:new:1')]: items('a'),
  };

  expect(projectWeightedTierLayout(previous, lists, { type: 'item', id: 'a' }).tiers[1]?.id).toBe('tier:new:2');
});
