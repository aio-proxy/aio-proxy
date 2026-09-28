import { ProviderKind } from '@aio-proxy/types';
import { expect, test } from '@rstest/core';

import {
  buildRoutingTiers,
  effectiveRoutingCandidates,
  explicitRoutingOverrides,
  formatTierShares,
} from './routing-summary';

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

test('preserves a __proto__ Provider override in the Save payload', () => {
  const draft = Object.defineProperty({}, '__proto__', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: { priority: 30 },
  });
  const providers = explicitRoutingOverrides(draft);
  expect(Object.hasOwn(providers, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(providers)).toBe(Object.prototype);
  expect(providers['__proto__']).toEqual({ priority: 30 });
});

test('labels a tier so its percents add up to 100', () => {
  // Rounded one by one, an even three-way split reads 33/33/33 and the tier appears to lose 1%.
  expect(formatTierShares([1 / 3, 1 / 3, 1 / 3])).toEqual(['34%', '33%', '33%']);
  expect(formatTierShares([0.5, 0.3, 0.2])).toEqual(['50%', '30%', '20%']);
});

test('labels a tiny but live candidate as under 1% rather than idle', () => {
  // Weight 1 beside 9999: rounding alone shows 0%, which reads as a Provider taking no traffic.
  expect(formatTierShares([9999 / 10_000, 1 / 10_000])).toEqual(['100%', '<1%']);
});
