import { expect, test } from '@rstest/core';

import { applicableQuotaItems, quotaPace, remainingPercent, tightestQuotaItem } from './quota-view';

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

const HOUR = 60 * 60 * 1000;
const sampledAt = Date.parse('2026-01-10T12:00:00Z');
// A 5-hour window one hour in: an even burn would still show 80% remaining.
const window = {
  id: 'five-hour',
  displayName: 'Five hour',
  resetsAt: sampledAt + 4 * HOUR,
  windowMinutes: 300,
} as const;

test('marks a window spent faster than evenly as overspent, and one spent slower as on track', () => {
  expect(quotaPace({ ...window, remainingRatio: 0.5 }, sampledAt)).toEqual({ expectedPercent: 80, overspent: true });
  expect(quotaPace({ ...window, remainingRatio: 0.95 }, sampledAt)).toEqual({ expectedPercent: 80, overspent: false });
});

// Within a couple of percent the tick would sit on the fill edge and restate what the bar shows.
test('draws no marker for a window burning close enough to evenly', () => {
  expect(quotaPace({ ...window, remainingRatio: 0.8 }, sampledAt)).toBeUndefined();
  expect(quotaPace({ ...window, remainingRatio: 0.82 }, sampledAt)).toBeUndefined();
  expect(quotaPace({ ...window, remainingRatio: 0.78 }, sampledAt)).toBeUndefined();
  // Just outside the band the marker returns, so the suppression is a band and not a rounding rule.
  expect(quotaPace({ ...window, remainingRatio: 0.77 }, sampledAt)?.overspent).toBe(true);
  expect(quotaPace({ ...window, remainingRatio: 0.83 }, sampledAt)?.overspent).toBe(false);
});

// The snapshot is cached server-side for minutes while the dashboard repolls, so pacing a held
// reading against a moving clock would slide the marker and could flip its colour with no new data.
test('places the marker from the sample time, not from a later clock', () => {
  const item = { ...window, remainingRatio: 0.7 };
  expect(quotaPace(item, sampledAt)).toEqual({ expectedPercent: 80, overspent: true });
  expect(quotaPace(item, sampledAt + 2 * HOUR)).toEqual({ expectedPercent: 40, overspent: false });
});

test('has no pace without both ends of the window, or when the reset does not fit inside one', () => {
  expect(quotaPace({ ...window, windowMinutes: undefined, remainingRatio: 0.8 }, sampledAt)).toBeUndefined();
  expect(quotaPace({ ...window, resetsAt: undefined, remainingRatio: 0.8 }, sampledAt)).toBeUndefined();
  // A reset already past, or further out than the whole window, means the reading cannot be placed.
  expect(quotaPace({ ...window, resetsAt: sampledAt - HOUR, remainingRatio: 0.8 }, sampledAt)).toBeUndefined();
  expect(quotaPace({ ...window, resetsAt: sampledAt + 6 * HOUR, remainingRatio: 0.8 }, sampledAt)).toBeUndefined();
});
