import { expect, test } from '@rstest/core';

import {
  DEVIATION_MIN_SAMPLE,
  DEVIATION_THRESHOLD,
  configuredRisks,
  countRoutingRisks,
  isDeviating,
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

const totals = (final: bigint, providerId: string) => ({
  providerId,
  finalCount: final,
  attemptCount: final,
  successCount: final,
  p95LatencyMs: 10,
});

test('classifies the two config-derived risks from eligibility alone', () => {
  expect(configuredRisks(model({ eligibleProviderCount: 0 }))).toEqual(['no-eligible']);
  expect(configuredRisks(model({ eligibleProviderCount: 1 }))).toEqual(['single-point']);
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

test('stays silent when the split matches its configuration', () => {
  expect(isDeviating(model(), [totals(50n, 'primary'), totals(50n, 'fallback')])).toBe(false);
});

test('reports deviation as unknown rather than false when traffic is absent', () => {
  // A missing traffic query must never read as "no deviation".
  expect(isDeviating(model(), undefined)).toBeUndefined();
});

test('counts config risks always and deviation only once traffic is known', () => {
  const models = [model({ modelId: 'a', eligibleProviderCount: 0 }), model({ modelId: 'b' })];
  const index = new Map([['b', [totals(93n, 'primary'), totals(7n, 'fallback')]]]);

  expect(countRoutingRisks(models, index)).toEqual({ 'no-eligible': 1, 'single-point': 0, deviating: 1 });
  // Without an index the deviation count is unknown, not zero.
  expect(countRoutingRisks(models, undefined)).toEqual({ 'no-eligible': 1, 'single-point': 0, deviating: undefined });
});

test('pins the thresholds as named constants so they are tunable in one place', () => {
  expect(DEVIATION_THRESHOLD).toBe(0.15);
  expect(DEVIATION_MIN_SAMPLE).toBe(50n);
});
