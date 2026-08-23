import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import { buildRoutingTiers, effectiveRoutingCandidates } from './routing-summary';

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

test('live preview excludes unavailable Providers from eligible tiers', () => {
  const number = { effective: 1, wasNormalized: false };
  const provider = {
    id: 'oauth',
    kind: ProviderKind.OAuth,
    enabled: true,
    state: {
      status: 'unavailable' as const,
      diagnostic: {
        code: 'CATALOG_UNAVAILABLE' as const,
        summary: 'Catalog unavailable',
        retryable: true,
        occurredAt: '2026-08-22T00:00:00.000Z',
      },
    },
    defaults: { priority: { effective: 20, wasNormalized: false }, weight: number },
    effective: {
      priority: 20,
      weight: 1,
      prioritySource: 'provider' as const,
      weightSource: 'provider' as const,
      eligible: true,
      share: null,
    },
  };
  expect(effectiveRoutingCandidates([provider], {})).toEqual([
    { providerId: 'oauth', priority: 20, weight: 1, eligible: false },
  ]);
});
