import { expect, test } from '@rstest/core';

import { indexRoutingTraffic, modelTrafficSummary, tierActualShares } from './routing-traffic';

const totals = (providerId: string, final: bigint, attempt: bigint, success: bigint, p95: number | null = 10) => ({
  providerId,
  finalCount: final,
  attemptCount: attempt,
  successCount: success,
  p95LatencyMs: p95,
});

const traffic = {
  range: '24h' as const,
  rangeStart: '2026-09-25T08:00:00.000Z',
  rangeEnd: '2026-09-26T08:00:00.000Z',
  models: [
    {
      modelId: 'sonnet',
      providers: [
        totals('primary', 93n, 100n, 50n),
        totals('fallback', 7n, 7n, 7n),
        totals('standby', 1000n, 1000n, 1000n),
      ],
    },
    // Traffic for a model the inventory no longer serves: it must never reach a denominator.
    { modelId: 'myprov/deleted', providers: [totals('primary', 1_000n, 1_000n, 1_000n)] },
  ],
};

const tier = {
  priority: 30,
  providers: [
    { providerId: 'primary', weight: 1, share: 0.5 },
    { providerId: 'fallback', weight: 1, share: 0.5 },
  ],
} as const;

test('computes actual share against the same tier the configured share uses', () => {
  const index = indexRoutingTraffic(traffic);
  const shares = tierActualShares(tier, index.get('sonnet'));

  // 93 / (93 + 7) — the tier's own members only.
  expect(shares.find((entry) => entry.providerId === 'primary')?.actualShare).toBeCloseTo(0.93, 5);
  expect(shares.find((entry) => entry.providerId === 'fallback')?.actualShare).toBeCloseTo(0.07, 5);
});

test('reports success rate over attempts, never over final ownership', () => {
  const index = indexRoutingTraffic(traffic);
  const shares = tierActualShares(tier, index.get('sonnet'));

  // primary served 93 but succeeded on only 50 of its 100 attempts. Dividing by finalCount
  // would report 0.54 and hide that half its attempts failed.
  expect(shares.find((entry) => entry.providerId === 'primary')?.successRate).toBeCloseTo(0.5, 5);
});

test('leaves success rate unknown rather than zero when nothing was attempted', () => {
  const index = indexRoutingTraffic({
    ...traffic,
    models: [{ modelId: 'sonnet', providers: [totals('primary', 1n, 0n, 0n, null)] }],
  });
  const shares = tierActualShares(tier, index.get('sonnet'));

  expect(shares.find((entry) => entry.providerId === 'primary')?.successRate).toBeNull();
});

test('a silent member of a tier that served traffic reads as a measured 0%', () => {
  // The query has no row for a Provider with no spans; inside an active tier that is a known 0%
  // share that can drift, not an unknown. Its success rate and latency stay unknown.
  const index = indexRoutingTraffic({
    ...traffic,
    models: [{ modelId: 'sonnet', providers: [totals('primary', 10n, 10n, 10n, 1200)] }],
  });
  const shares = tierActualShares(tier, index.get('sonnet'));

  expect(shares.find((entry) => entry.providerId === 'fallback')).toEqual({
    providerId: 'fallback',
    actualShare: 0,
    successRate: null,
    p95LatencyMs: null,
    finalCount: 0n,
  });
});

test('a tier that served nothing reports no split but keeps its attempt rates', () => {
  // Every attempt failed: 0% would claim a measured split. The share is unknown, while the success
  // rate (all failed) is still a real observation.
  const index = indexRoutingTraffic({
    ...traffic,
    models: [{ modelId: 'sonnet', providers: [totals('primary', 0n, 4n, 0n, 900)] }],
  });
  const primary = tierActualShares(tier, index.get('sonnet')).find((entry) => entry.providerId === 'primary');

  expect(primary?.actualShare).toBeNull();
  expect(primary?.successRate).toBe(0);
});

test('yields no shares when the model has no traffic at all', () => {
  // Absent is not zero: the bar must render without a thin overlay rather than a 0% overlay.
  expect(tierActualShares(tier, undefined)).toEqual([]);
});

test('drops traffic rows the inventory does not serve', () => {
  const index = indexRoutingTraffic(traffic);

  // The row exists in the index (keyed by requested model id) but a tier that does not name
  // it can never pull it into a denominator.
  expect(index.has('myprov/deleted')).toBe(true);
  const shares = tierActualShares(tier, index.get('sonnet'));
  expect(shares.map((entry) => entry.providerId).sort()).toEqual(['fallback', 'primary']);
});

test('summarises a model over every tier for the traffic column', () => {
  const index = indexRoutingTraffic(traffic);

  expect(modelTrafficSummary(index.get('sonnet'))).toEqual({
    finalCount: 1100n,
    attemptCount: 1107n,
    successCount: 1057n,
    successRate: 1057 / 1107,
  });
});

test('summarises nothing for a model with no traffic', () => {
  expect(modelTrafficSummary(undefined)).toBeUndefined();
});
