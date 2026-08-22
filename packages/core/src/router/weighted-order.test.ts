import { expect, test } from 'bun:test';

import { orderWeightedCandidates } from './weighted-order';

const candidate = (id: string, priority: number, weight: number, configurationIndex: number) => ({
  provider: { id },
  routing: { priority, weight, configurationIndex },
});

test('orders higher priority tiers before weighted candidates', () => {
  const candidates = [candidate('low', 10, 10, 0), candidate('high-a', 20, 3, 1), candidate('high-b', 20, 1, 2)];

  expect(orderWeightedCandidates(candidates, () => 0).map((item) => item.provider.id)).toEqual([
    'high-a',
    'high-b',
    'low',
  ]);
});

test('draws without replacement inside a tier', () => {
  const draws = [0.9, 0];
  expect(
    orderWeightedCandidates([candidate('a', 0, 3, 0), candidate('b', 0, 1, 1)], () => draws.shift()!).map(
      (item) => item.provider.id,
    ),
  ).toEqual(['b', 'a']);
});
