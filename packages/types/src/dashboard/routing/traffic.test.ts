import { describe, expect, test } from 'bun:test';

import * as dashboard from '../index';

const provider = {
  providerId: 'primary',
  finalCount: '120',
  attemptCount: '140',
  successCount: '125',
  p95LatencyMs: 1_240,
} as const;

describe('dashboard routing traffic contracts', () => {
  test('parses a totals response and keeps counts as decimal strings', () => {
    const totals = Reflect.get(dashboard, 'DashboardRoutingTrafficResponseSchema') as {
      parse: (value: unknown) => unknown;
    };
    const value = {
      range: '24h',
      from: '2026-09-24T08:00:00.000Z',
      to: '2026-09-25T08:00:00.000Z',
      models: [{ modelId: 'anthropic/claude-sonnet-4.5', providers: [provider] }],
    };

    expect(totals.parse(value)).toEqual(value);
  });

  test('allows a null p95 when a provider has no completed attempt', () => {
    const totals = Reflect.get(dashboard, 'DashboardRoutingTrafficResponseSchema') as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const base = {
      range: '7d',
      from: '2026-09-18T00:00:00.000Z',
      to: '2026-09-25T08:00:00.000Z',
      models: [{ modelId: 'gpt-5-codex', providers: [{ ...provider, p95LatencyMs: null }] }],
    };

    expect(totals.safeParse(base).success).toBe(true);
    expect(totals.safeParse({ ...base, range: '90d' }).success).toBe(false);
    expect(
      totals.safeParse({ ...base, models: [{ modelId: 'x', providers: [{ ...provider, finalCount: 120 }] }] }).success,
    ).toBe(false);
  });

  test('parses a buckets response for one model', () => {
    const buckets = Reflect.get(dashboard, 'DashboardRoutingTrafficBucketsResponseSchema') as {
      parse: (value: unknown) => unknown;
    };
    const value = {
      range: '24h',
      modelId: 'anthropic/claude-sonnet-4.5',
      from: '2026-09-24T08:00:00.000Z',
      to: '2026-09-25T08:00:00.000Z',
      bucketUnit: 'hour',
      providerIds: ['primary', 'fallback'],
      buckets: [{ bucket: '2026-09-24T08:00:00.000Z', values: { primary: '5', fallback: '1' } }],
    };

    expect(buckets.parse(value)).toEqual(value);
  });
});
