import { expect, test } from '@rstest/core';

import { applicableQuotaItems, remainingPercent, tightestQuotaItem } from './quota-view';

test('keeps only the windows that report a remaining amount', () => {
  expect(
    applicableQuotaItems({
      items: [
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
        { id: 'unrated', displayName: 'Unrated' },
        { id: 'empty', displayName: 'Empty', remainingRatio: 0 },
      ],
    }).map((item) => item.id),
    // A window at 0% still reports a number, so it stays: exhausted is not the same as unreported.
  ).toEqual(['weekly', 'empty']);
  expect(applicableQuotaItems(undefined)).toEqual([]);
});

test('picks the item with the lowest remaining ratio', () => {
  const snapshot = {
    items: [
      { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.8 },
      { id: 'five-hour', displayName: 'Five hour', remainingRatio: 0.1 },
    ],
  };
  expect(tightestQuotaItem(snapshot)?.id).toBe('five-hour');
});

test('an item without a ratio never wins and an all-unrated snapshot has no tightest item', () => {
  expect(
    tightestQuotaItem({
      items: [
        { id: 'unrated', displayName: 'Unrated' },
        { id: 'weekly', displayName: 'Weekly', remainingRatio: 0.9 },
      ],
    })?.id,
  ).toBe('weekly');
  expect(tightestQuotaItem({ items: [{ id: 'unrated', displayName: 'Unrated' }] })).toBeUndefined();
  expect(tightestQuotaItem(undefined)).toBeUndefined();
});

test('rounds toward the nearest percent but never rounds a non-empty quota to zero', () => {
  expect(remainingPercent(0.5)).toBe(50);
  expect(remainingPercent(0.004)).toBe(1);
  expect(remainingPercent(0)).toBe(0);
  expect(remainingPercent(1)).toBe(100);
});
