import { expect, test } from '@rstest/core';

import {
  DEVIATION_MIN_SAMPLE,
  DEVIATION_THRESHOLD,
  configuredRisks,
  isDeviating,
  tierDeviations,
} from './routing-risk';

const model = (over: Partial<Parameters<typeof configuredRisks>[0]> = {}) =>
  ({
    modelId: 'sonnet',
    revision: 'rev-1',
    baselineProviderIds: [],
    providerCount: 2,
    eligibleProviderCount: 2,
    hasOverrides: false,
    tiers: [
      {
        priority: 30,
        providers: [
          { providerId: 'primary', weight: 1, share: 0.5 },
          { providerId: 'fallback', weight: 1, share: 0.5 },
        ],
      },
    ],
    providers: [],
    ...over,
  }) as Parameters<typeof configuredRisks>[0];

/**
 * Every count gets a distinct value on purpose: deviation is judged off `finalCount` alone, and a
 * fixture that reused one number for all three would let a swap to `attemptCount` or
 * `successCount` pass unnoticed.
 */
const totals = (final: bigint, providerId: string) => ({
  providerId,
  finalCount: final,
  attemptCount: final * 3n + 1n,
  successCount: final * 2n + 1n,
  p95LatencyMs: 10,
});

test('flags a model no Provider can serve, and not one served by a single Provider', () => {
  expect(configuredRisks(model({ eligibleProviderCount: 0 }))).toEqual(['no-eligible']);
  // One Provider is the norm for most models, with no second upstream to add.
  expect(configuredRisks(model({ eligibleProviderCount: 1 }))).toEqual([]);
  expect(configuredRisks(model({ eligibleProviderCount: 2 }))).toEqual([]);
});

test('flags a split that ran far from its configuration', () => {
  // Configured 50/50, observed 93/7 over a large sample.
  expect(isDeviating(model(), [totals(93n, 'primary'), totals(7n, 'fallback')])).toBe(true);
});

test('stays silent when the sample is too small to mean anything', () => {
  // Same 93/7 ratio, but only 10 requests: the threshold would be pure noise here.
  expect(isDeviating(model(), [totals(9n, 'primary'), totals(1n, 'fallback')])).toBe(false);
});

test('sizes the sample from served requests, not from attempts', () => {
  // Retries make attemptCount far larger than finalCount. This tier served 22 requests but
  // attempted 68, so a gate reading attempts would judge it and report its 91/9 split as
  // divergence off a sample that is still noise.
  expect(isDeviating(model(), [totals(20n, 'primary'), totals(2n, 'fallback')])).toBe(false);
});

test('stays silent when the split matches its configuration', () => {
  expect(isDeviating(model(), [totals(50n, 'primary'), totals(50n, 'fallback')])).toBe(false);
});

test('reports deviation as unknown rather than false when traffic is absent', () => {
  // A missing traffic query must never read as "no deviation".
  expect(isDeviating(model(), undefined)).toBeUndefined();
});

test('pins the thresholds as named constants so they are tunable in one place', () => {
  expect(DEVIATION_THRESHOLD).toBe(0.15);
  expect(DEVIATION_MIN_SAMPLE).toBe(50n);
});

test('flags a configured provider that received no traffic while its tier was active', () => {
  const fourWay = model({
    tiers: [
      {
        priority: 30,
        providers: [
          { providerId: 'silent', weight: 2, share: 0.4 },
          { providerId: 'a', weight: 1, share: 0.2 },
          { providerId: 'b', weight: 1, share: 0.2 },
          { providerId: 'c', weight: 1, share: 0.2 },
        ],
      },
    ],
  });
  expect(isDeviating(fourWay, [totals(30n, 'a'), totals(30n, 'b'), totals(30n, 'c')])).toBe(true);
});

test('does not flag an unused fallback tier with no traffic rows', () => {
  const primaryOnly = model({
    tiers: [
      {
        priority: 30,
        providers: [{ providerId: 'primary', weight: 1, share: 1 }],
      },
      {
        priority: 10,
        providers: [
          { providerId: 'fb-a', weight: 1, share: 0.5 },
          { providerId: 'fb-b', weight: 1, share: 0.5 },
        ],
      },
    ],
  });
  expect(isDeviating(primaryOnly, [totals(80n, 'primary')])).toBe(false);
});

test('judges the sample per tier, so a busy primary cannot vouch for a fallback tier', () => {
  // The gate used to sum the whole model, so a single failover request was judged as if it had the
  // primary tier's sample: fb-a read 100% against a configured 50% and the model went red while
  // its live traffic was a perfectly balanced primary tier.
  const withFallback = model({
    tiers: [
      { priority: 30, providers: [{ providerId: 'primary', weight: 1, share: 1 }] },
      {
        priority: 10,
        providers: [
          { providerId: 'fb-a', weight: 1, share: 0.5 },
          { providerId: 'fb-b', weight: 1, share: 0.5 },
        ],
      },
    ],
  });

  expect(isDeviating(withFallback, [totals(1000n, 'primary'), totals(1n, 'fb-a')])).toBe(false);
  // Once the fallback tier itself carries a real sample, the same lopsided split is reported.
  expect(isDeviating(withFallback, [totals(1000n, 'primary'), totals(60n, 'fb-a')])).toBe(true);
});

test('still judges a tier that alone clears the minimum inside a quiet model', () => {
  expect(isDeviating(model(), [totals(50n, 'primary'), totals(1n, 'fallback')])).toBe(true);
});

test('names the Providers that ran off their configured split, with the measured share', () => {
  const [tier] = model().tiers;
  if (tier === undefined) throw new Error('fixture has a tier');

  expect([...tierDeviations(tier, [totals(93n, 'primary'), totals(7n, 'fallback')])]).toEqual([
    ['primary', 0.93],
    ['fallback', 0.07],
  ]);
  expect(tierDeviations(tier, [totals(9n, 'primary'), totals(1n, 'fallback')]).size).toBe(0);
});
