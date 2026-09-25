import { describe, expect, test } from 'bun:test';

import type { ZodType } from 'zod';

import * as dashboard from '../index';

const schema = (name: string): ZodType => {
  expect(dashboard).toHaveProperty(name);
  return Reflect.get(dashboard, name) as ZodType;
};

const provider = {
  providerId: 'primary',
  finalCount: '120',
  attemptCount: '140',
  successCount: '125',
  p95LatencyMs: 1_240,
} as const;

const buckets = {
  range: '24h',
  modelId: 'anthropic/claude-sonnet-4.5',
  rangeStart: '2026-09-24T08:00:00.000Z',
  rangeEnd: '2026-09-25T08:00:00.000Z',
  bucketUnit: 'hour',
  providerIds: ['primary', 'fallback'],
  buckets: [{ key: '2026-09-24T08:00:00.000Z', values: { primary: '5', fallback: '1' } }],
} as const;

// Shared by the three totals contract checks below, each of which mutates one field.
const nullP95Totals = {
  range: '7d',
  rangeStart: '2026-09-18T00:00:00.000Z',
  rangeEnd: '2026-09-25T08:00:00.000Z',
  models: [{ modelId: 'gpt-5-codex', providers: [{ ...provider, p95LatencyMs: null }] }],
} as const;

describe('dashboard routing traffic contracts', () => {
  test('parses a totals response and keeps counts as decimal strings', () => {
    const totals = schema('DashboardRoutingTrafficResponseSchema');
    const value = {
      range: '24h',
      rangeStart: '2026-09-24T08:00:00.000Z',
      rangeEnd: '2026-09-25T08:00:00.000Z',
      models: [{ modelId: 'anthropic/claude-sonnet-4.5', providers: [provider] }],
    };

    expect(totals.parse(value)).toEqual(value);
  });

  test('allows a null p95 when a provider has no completed attempt', () => {
    const totals = schema('DashboardRoutingTrafficResponseSchema');

    expect(totals.safeParse(nullP95Totals).success).toBe(true);
  });

  test('rejects a range outside the charted windows', () => {
    const totals = schema('DashboardRoutingTrafficResponseSchema');

    expect(totals.safeParse({ ...nullP95Totals, range: '90d' }).success).toBe(false);
  });

  test('rejects a count that did not travel as a decimal string', () => {
    const totals = schema('DashboardRoutingTrafficResponseSchema');
    const value = {
      ...nullP95Totals,
      models: [{ modelId: 'gpt-5-codex', providers: [{ ...provider, finalCount: 120 }] }],
    };

    expect(totals.safeParse(value).success).toBe(false);
  });

  test('rejects an unknown key on a traffic provider', () => {
    const totals = schema('DashboardRoutingTrafficResponseSchema');
    const value = {
      range: '24h',
      rangeStart: '2026-09-24T08:00:00.000Z',
      rangeEnd: '2026-09-25T08:00:00.000Z',
      models: [
        {
          modelId: 'anthropic/claude-sonnet-4.5',
          providers: [{ ...provider, failureCount: '15' }],
        },
      ],
    };

    expect(totals.safeParse(value).success).toBe(false);
  });

  test('parses a buckets response for one model', () => {
    expect(schema('DashboardRoutingTrafficBucketsResponseSchema').parse(buckets)).toEqual(buckets);
  });

  test('rejects a bucket unit outside the charted granularities', () => {
    const response = schema('DashboardRoutingTrafficBucketsResponseSchema');

    expect(response.safeParse({ ...buckets, bucketUnit: 'week' }).success).toBe(false);
  });
});
