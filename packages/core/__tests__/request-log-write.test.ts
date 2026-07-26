import { describe, expect, test } from 'bun:test';

import {
  createRequestLogStore,
  DashboardUsageOverviewResponseSchema,
  eq,
  now,
  openDb,
  requestLog,
  rows,
  seedBase,
  tempHome,
  usage,
} from './request-log.test-support';

describe('request log store', () => {
  test('returns a schema-valid zero summary for an empty database', () => {
    const handle = openDb({ home: tempHome() });
    try {
      const overview = createRequestLogStore(handle.db).overview({
        range: '24h',
        metric: 'requests',
        groupBy: 'model',
        now,
      });

      expect(overview.summary).toEqual({
        estimatedCostUsd: 0,
        pricingCoverage: null,
        pricedRequestCount: 0,
        usageRequestCount: 0,
        requestCount: 0,
        successCount: 0,
        failureCount: 0,
        cancelledCount: 0,
        successRate: null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        averageRpm: 0,
        averageTpm: 0,
      });
      expect(DashboardUsageOverviewResponseSchema.parse(overview)).toEqual(overview);
    } finally {
      handle.close();
    }
  });

  test('stores terminal requests with optional successful usage and aggregates the summary', () => {
    const { handle, store } = seedBase();
    try {
      const overview = store.overview({ range: '24h', metric: 'requests', groupBy: 'model', now });

      expect(overview.summary).toEqual({
        estimatedCostUsd: 0.25,
        pricingCoverage: 1,
        pricedRequestCount: 1,
        usageRequestCount: 1,
        requestCount: 3,
        successCount: 1,
        failureCount: 1,
        cancelledCount: 1,
        successRate: 0.5,
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        averageRpm: 3 / 1440,
        averageTpm: 150 / 1440,
      });
      expect(overview.buckets).toHaveLength(24);
      expect(overview.series.map(({ key }) => key)).toEqual(['openai/gpt-5', '__failed__', '__cancelled__']);
      expect(overview.series.map(({ kind }) => kind)).toEqual(['dimension', 'failed', 'cancelled']);
      expect(overview.buckets[0]).toEqual({
        key: '2026-07-10T08:00:00.000Z',
        values: { 'openai/gpt-5': 0, __failed__: 0, __cancelled__: 0 },
      });

      const storedUsage = handle.db.select().from(usage).all();
      expect(storedUsage).toHaveLength(1);
      expect(storedUsage[0]).toMatchObject({
        requestId: 'request-success-a',
        providerId: 'openrouter',
        modelId: 'openai/gpt-5',
        createdAt: rows[0].completedAt,
      });
      expect(
        handle.db.select().from(requestLog).where(eq(requestLog.requestId, rows[0].requestId)).get()?.attempts,
      ).toEqual(rows[0].attempts);
    } finally {
      handle.close();
    }
  });
});
