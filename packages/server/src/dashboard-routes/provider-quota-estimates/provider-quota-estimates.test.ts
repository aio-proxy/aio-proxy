import { expect, test } from 'bun:test';

import { quotaWindowEstimates } from './provider-quota-estimates';

const HOUR = 60 * 60 * 1000;
const sampledAt = Date.parse('2026-01-10T12:00:00.000Z');
const fiveHour = {
  id: 'five-hour',
  displayName: 'Five hour',
  remainingRatio: 0.5,
  resetsAt: sampledAt + 4 * HOUR,
  windowMinutes: 300,
} as const;
const weekly = {
  id: 'weekly',
  displayName: 'Weekly',
  remainingRatio: 0.8,
  resetsAt: sampledAt + 6 * 24 * HOUR,
  windowMinutes: 7 * 24 * 60,
} as const;

test('emits usedNanoUsd for windows with usable bounds and skips the rest', () => {
  const costs = new Map<string, string | undefined>();
  const estimates = quotaWindowEstimates(
    {
      sampledAt,
      snapshot: {
        items: [
          fiveHour,
          weekly,
          { id: 'unrated', displayName: 'Unrated', resetsAt: fiveHour.resetsAt, windowMinutes: 300 },
          { id: 'no-window', displayName: 'No window', remainingRatio: 0.2 },
          { id: 'past', displayName: 'Past', remainingRatio: 0.2, resetsAt: sampledAt - HOUR, windowMinutes: 300 },
        ],
      },
    },
    (range) => {
      const key = `${range.start.getTime()}:${range.end.getTime()}`;
      costs.set(key, key === `${sampledAt - HOUR}:${sampledAt}` ? '100000000' : '500000000');
      return costs.get(key);
    },
  );

  expect(estimates).toEqual([
    { itemId: 'five-hour', usedNanoUsd: '100000000', basis: 'local-api-equivalent' },
    { itemId: 'weekly', usedNanoUsd: '500000000', basis: 'local-api-equivalent' },
  ]);
  expect(costs.size).toBe(2);
});

test('reuses one cost query when two items share bounds', () => {
  let calls = 0;
  const estimates = quotaWindowEstimates(
    {
      sampledAt,
      snapshot: {
        items: [fiveHour, { ...fiveHour, id: 'five-hour-copy', displayName: 'Copy' }],
      },
    },
    () => {
      calls += 1;
      return '1';
    },
  );

  expect(calls).toBe(1);
  expect(estimates?.map((row) => row.itemId)).toEqual(['five-hour', 'five-hour-copy']);
});

test('omits estimates when no priced cost exists', () => {
  expect(quotaWindowEstimates({ sampledAt, snapshot: { items: [fiveHour] } }, () => undefined)).toBeUndefined();
});

test('a priced zero is kept', () => {
  expect(quotaWindowEstimates({ sampledAt, snapshot: { items: [fiveHour] } }, () => '0')).toEqual([
    { itemId: 'five-hour', usedNanoUsd: '0', basis: 'local-api-equivalent' },
  ]);
});
