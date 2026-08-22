import { expect, test } from '@rstest/core';

import { buildRoutingTiers } from './routing-summary';

const effective = (providerId: string, priority: number, weight: number) => ({
  providerId,
  priority,
  weight,
  eligible: weight > 0,
});

test('groups eligible Providers into descending priority tiers with shares', () => {
  expect(
    buildRoutingTiers([
      effective('a', 30, 6000),
      effective('b', 30, 4000),
      effective('c', 20, 1000),
      effective('off', 50, 0),
    ]),
  ).toEqual([
    {
      priority: 30,
      providers: [
        { providerId: 'a', weight: 6000, share: 0.6 },
        { providerId: 'b', weight: 4000, share: 0.4 },
      ],
    },
    { priority: 20, providers: [{ providerId: 'c', weight: 1000, share: 1 }] },
  ]);
});

test('omits Providers that are known but not eligible even when weight is positive', () => {
  expect(
    buildRoutingTiers([
      { providerId: 'ready', priority: 10, weight: 1, eligible: true },
      { providerId: 'disabled', priority: 90, weight: 9, eligible: false },
    ]),
  ).toEqual([{ priority: 10, providers: [{ providerId: 'ready', weight: 1, share: 1 }] }]);
});

test('returns no tiers when every Provider is ineligible', () => {
  expect(buildRoutingTiers([effective('off', 50, 0)])).toEqual([]);
});
