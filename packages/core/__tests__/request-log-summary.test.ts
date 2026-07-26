import { describe, expect, test } from 'bun:test';

import { createRequestLogStore, now, openDb, seedBase, tempHome } from './request-log.test-support';

describe('request log store', () => {
  test('token and cost charts only include successful requests with usage and omit cache and reasoning from TPM', () => {
    const { handle, store } = seedBase();
    try {
      const tokens = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now });
      const cost = store.overview({ range: '24h', metric: 'cost', groupBy: 'model', now });

      expect(tokens.series).toEqual([{ key: 'openai/gpt-5', kind: 'dimension' }]);
      expect(tokens.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(150);
      expect(cost.series).toEqual([{ key: 'openai/gpt-5', kind: 'dimension' }]);
      expect(cost.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(0.25);
      expect(tokens.summary.averageTpm).toBe(150 / 1440);
    } finally {
      handle.close();
    }
  });

  test('anchors rolling hourly buckets at a non-hour range start without losing boundary rows', () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      const rollingNow = new Date('2026-07-11T08:30:00.000Z');
      const rollingStart = new Date('2026-07-10T08:30:00.000Z');
      store.insertFinal({
        requestId: 'rolling-early',
        inboundProtocol: 'openai-compatible',
        requestedModelId: 'mini',
        outcome: 'failure',
        attempts: [],
        startedAt: new Date(rollingStart.getTime() + 14 * 60_000),
        completedAt: new Date(rollingStart.getTime() + 15 * 60_000),
        durationMs: 60_000,
      });
      store.insertFinal({
        requestId: 'rolling-end',
        inboundProtocol: 'openai-compatible',
        requestedModelId: 'mini',
        outcome: 'success',
        finalProviderId: 'openrouter',
        finalModelId: 'openai/gpt-5',
        attempts: [],
        startedAt: new Date(rollingNow.getTime() - 1_000),
        completedAt: rollingNow,
        durationMs: 1_000,
        usage: {
          providerId: 'openrouter',
          modelId: 'openai/gpt-5',
          inputTokens: 10,
          outputTokens: 5,
        },
      });

      const requests = store.overview({ range: '24h', metric: 'requests', groupBy: 'model', now: rollingNow });
      const tokens = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now: rollingNow });
      expect(requests.buckets).toHaveLength(24);
      expect(requests.buckets[0]?.key).toBe('2026-07-10T08:30:00.000Z');
      expect(requests.buckets.at(-1)?.key).toBe('2026-07-11T07:30:00.000Z');
      expect(requests.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(
        requests.summary.requestCount,
      );
      expect(tokens.buckets.flatMap(({ values }) => Object.values(values)).reduce((a, b) => a + b, 0)).toBe(
        tokens.summary.totalTokens,
      );
    } finally {
      handle.close();
    }
  });

  test('keeps the top five dimensions and folds remaining successful models into Other', () => {
    const handle = openDb({ home: tempHome() });
    try {
      const store = createRequestLogStore(handle.db);
      for (let index = 0; index < 6; index += 1) {
        store.insertFinal({
          requestId: `top-${index}`,
          inboundProtocol: 'openai-compatible',
          requestedModelId: `alias-${index}`,
          outcome: 'success',
          finalProviderId: `provider-${index}`,
          finalModelId: `model-${index}`,
          attempts: [],
          startedAt: new Date(now.getTime() - 60_000),
          completedAt: new Date(now.getTime() - 1_000),
          durationMs: 59_000,
          usage: {
            providerId: `provider-${index}`,
            modelId: `model-${index}`,
            inputTokens: 6 - index,
            outputTokens: 0,
            totalTokens: 6 - index,
          },
        });
      }

      const overview = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now });
      expect(overview.series).toEqual([
        { key: 'model-0', kind: 'dimension' },
        { key: 'model-1', kind: 'dimension' },
        { key: 'model-2', kind: 'dimension' },
        { key: 'model-3', kind: 'dimension' },
        { key: 'model-4', kind: 'dimension' },
        { key: '__other__', kind: 'other' },
      ]);
      expect(overview.buckets.flatMap(({ values }) => [values.__other__]).reduce((a, b) => a + b, 0)).toBe(1);
    } finally {
      handle.close();
    }
  });
});
