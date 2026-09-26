import { expect, test } from '@rstest/core';

import { decodeRoutingTraffic } from './routing-traffic-service';

const wire = {
  range: '24h' as const,
  rangeStart: '2026-09-25T08:00:00.000Z',
  rangeEnd: '2026-09-26T08:00:00.000Z',
  models: [
    {
      modelId: 'anthropic/claude-sonnet-4.5',
      providers: [
        { providerId: 'primary', finalCount: '4', attemptCount: '2', successCount: '1', p95LatencyMs: 60 },
        {
          providerId: 'fallback',
          finalCount: '9007199254740993',
          attemptCount: '7',
          successCount: '5',
          p95LatencyMs: null,
        },
      ],
    },
  ],
};

test('decodes counts past the JS safe-integer boundary', () => {
  const decoded = decodeRoutingTraffic(wire);
  const primary = decoded.models[0]?.providers[0];
  const fallback = decoded.models[0]?.providers[1];

  // 9007199254740993 is Number.MAX_SAFE_INTEGER + 2: Number() would round it to ...992.
  // Each count is distinct so a swap among final, attempt, and success fails here.
  expect(fallback?.finalCount).toBe(9_007_199_254_740_993n);
  expect(fallback?.attemptCount).toBe(7n);
  expect(fallback?.successCount).toBe(5n);
  expect(primary?.finalCount).toBe(4n);
  expect(primary?.attemptCount).toBe(2n);
  expect(primary?.successCount).toBe(1n);
});

test('keeps a null p95 as null rather than coercing it to zero', () => {
  // 0 would read as "zero latency"; absent and instant are different facts.
  expect(decodeRoutingTraffic(wire).models[0]?.providers[1]?.p95LatencyMs).toBeNull();
  expect(decodeRoutingTraffic(wire).models[0]?.providers[0]?.p95LatencyMs).toBe(60);
});

test('passes the window bounds through untouched', () => {
  expect(decodeRoutingTraffic(wire)).toMatchObject({
    range: '24h',
    rangeStart: wire.rangeStart,
    rangeEnd: wire.rangeEnd,
  });
});
