import { describe, expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import type { StoredSpan, TraceCompletion, TraceRootStart } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');

function makeStore() {
  const handle = openTestDb();
  return { handle, store: createTraceStore(handle.db) };
}

function bucketTotal(buckets: readonly { readonly values: Readonly<Record<string, string | number>> }[]): bigint {
  return buckets
    .flatMap(({ values }) => Object.values(values))
    .reduce((total, value) => total + BigInt(String(value)), 0n);
}

function rootStart(traceId: string, startedAt: Date, attrs: Record<string, unknown> = {}): TraceRootStart {
  return {
    traceId,
    spanId: traceId.slice(0, 16),
    requestId: `req-${traceId.slice(0, 8)}`,
    inboundProtocol: 'openai-compatible',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt,
    statusCode: 0,
    attributes: { 'aio_proxy.protocol.inbound': 'openai-compatible', ...attrs },
    events: [],
    links: [],
  };
}

function rootSpan(traceId: string, startedAt: Date, endedAt: Date, attrs: Record<string, unknown>): StoredSpan {
  return {
    traceId,
    spanId: traceId.slice(0, 16),
    name: 'aio_proxy.request',
    kind: 1,
    startedAt,
    endedAt,
    statusCode: 0,
    attributes: attrs,
    events: [],
    links: [],
  };
}

function attrsFor(summary: TraceCompletion['summary']): Record<string, unknown> {
  const attrs: Record<string, unknown> = {};
  if (summary.finalProviderId !== undefined) attrs['aio_proxy.route.final_provider_id'] = summary.finalProviderId;
  if (summary.finalModelId !== undefined) attrs['gen_ai.response.model'] = summary.finalModelId;
  if (summary.usage !== undefined) {
    if (summary.usage.inputTokens !== undefined) attrs['gen_ai.usage.input_tokens'] = summary.usage.inputTokens;
    if (summary.usage.outputTokens !== undefined) attrs['gen_ai.usage.output_tokens'] = summary.usage.outputTokens;
    if (summary.usage.totalTokens !== undefined) attrs['gen_ai.usage.total_tokens'] = summary.usage.totalTokens;
    if (summary.usage.estimatedCostUsd !== undefined)
      attrs['gen_ai.usage.estimated_cost_usd'] = summary.usage.estimatedCostUsd;
  }
  return attrs;
}

function complete(
  store: ReturnType<typeof createTraceStore>,
  traceId: string,
  startedAt: Date,
  endedAt: Date,
  summary: TraceCompletion['summary'],
  extra: Record<string, unknown> = {},
) {
  const attrs = { ...attrsFor(summary), ...extra };
  store.startRoot(rootStart(traceId, startedAt, attrs));
  store.complete({
    traceId,
    rootSpanId: traceId.slice(0, 16),
    spans: [rootSpan(traceId, startedAt, endedAt, attrs)],
    summary,
  });
}

describe('usage overview from trace roots', () => {
  test('token and cost charts only include successful requests with usage', () => {
    const { handle, store } = makeStore();
    try {
      const t = '1'.repeat(32);
      complete(
        store,
        t,
        new Date(NOW.getTime() - 1000),
        NOW,
        {
          finalProviderId: 'openrouter',
          finalModelId: 'openai/gpt-5',
          finalHttpStatus: 200,
          usage: {
            providerId: 'openrouter',
            modelId: 'openai/gpt-5',
            inputTokens: 100,
            outputTokens: 50,
            totalTokens: 150,
            estimatedCostUsd: 0.25,
          },
        },
        { 'gen_ai.response.model': 'openai/gpt-5', 'aio_proxy.route.final_provider_id': 'openrouter' },
      );

      const tokens = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now: NOW });
      const cost = store.overview({ range: '24h', metric: 'cost', groupBy: 'model', now: NOW });

      expect(tokens.series).toEqual([{ key: 'openai/gpt-5', kind: 'dimension' }]);
      expect(tokens.buckets.flatMap(({ values }) => Object.values(values)).filter((value) => value !== '0')).toEqual([
        '150',
      ]);
      expect(cost.series).toEqual([{ key: 'openai/gpt-5', kind: 'dimension' }]);
      expect(cost.buckets.flatMap(({ values }) => Object.values(values)).filter((value) => value !== '0')).toEqual([
        '250000000',
      ]);
    } finally {
      handle.close();
    }
  });

  test('counts usage from any persisted token field, not only inputTokens', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), new Date(NOW.getTime() - 1000), NOW, {
        finalProviderId: 'openrouter',
        finalModelId: 'openai/gpt-5',
        finalHttpStatus: 200,
        usage: { providerId: 'openrouter', modelId: 'openai/gpt-5', outputTokens: 50 },
      });

      const overview = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now: NOW });
      expect(overview.summary.usageRequestCount).toBe('1');
    } finally {
      handle.close();
    }
  });

  test('keeps reserved and path-like model ids separate with chart-safe keys', () => {
    const { handle, store } = makeStore();
    try {
      for (const [index, modelId] of ['__failed__', '__cancelled__', '__other__', 'gpt-4.1'].entries()) {
        complete(
          store,
          `${index}a`.padEnd(32, '0'),
          new Date(NOW.getTime() - 1000),
          NOW,
          {
            finalProviderId: 'provider',
            finalModelId: modelId,
            finalHttpStatus: 200,
          },
          { 'gen_ai.response.model': modelId, 'aio_proxy.route.final_provider_id': 'provider' },
        );
      }
      complete(store, 'f'.padEnd(32, '0'), new Date(NOW.getTime() - 1000), NOW, {
        terminationReason: 'failure',
      });
      complete(store, 'g'.padEnd(32, '0'), new Date(NOW.getTime() - 1000), NOW, {
        terminationReason: 'cancelled',
      });

      const overview = store.overview({ range: '24h', metric: 'requests', groupBy: 'model', now: NOW });
      expect(overview.series).toEqual([
        { key: 'dimension:__cancelled__', kind: 'dimension' },
        { key: 'dimension:__failed__', kind: 'dimension' },
        { key: 'dimension:__other__', kind: 'dimension' },
        { key: 'dimension:gpt-4%2E1', kind: 'dimension' },
        { key: '__failed__', kind: 'failed' },
        { key: '__cancelled__', kind: 'cancelled' },
      ]);
      expect(bucketTotal(overview.buckets)).toBe(6n);
    } finally {
      handle.close();
    }
  });

  test('uses server-local calendar days and actual elapsed minutes for multi-day ranges', () => {
    const { handle, store } = makeStore();
    try {
      const expectedStart = new Date(NOW);
      expectedStart.setHours(0, 0, 0, 0);
      expectedStart.setDate(expectedStart.getDate() - 6);
      const elapsedMinutes = (NOW.getTime() - expectedStart.getTime()) / 60_000;

      complete(
        store,
        '1'.repeat(32),
        new Date('2026-07-11T07:00:00.000Z'),
        new Date('2026-07-11T07:00:00.100Z'),
        {
          finalProviderId: 'openrouter',
          finalModelId: 'openai/gpt-5',
          finalHttpStatus: 200,
          usage: { providerId: 'openrouter', modelId: 'openai/gpt-5', inputTokens: 100, outputTokens: 50 },
        },
        { 'gen_ai.response.model': 'openai/gpt-5' },
      );
      complete(store, '2'.repeat(32), new Date('2026-07-11T07:30:00.000Z'), new Date('2026-07-11T07:30:00.050Z'), {
        terminationReason: 'failure',
      });
      complete(store, '3'.repeat(32), new Date('2026-07-11T07:45:00.000Z'), new Date('2026-07-11T07:45:00.010Z'), {
        terminationReason: 'cancelled',
      });

      const overview = store.overview({ range: '7d', metric: 'requests', groupBy: 'provider', now: NOW });
      expect(overview.rangeStart).toBe(expectedStart.toISOString());
      expect(overview.rangeEnd).toBe(NOW.toISOString());
      expect(overview.bucketUnit).toBe('day');
      expect(overview.buckets).toHaveLength(7);
      expect(overview.summary.averageRpm).toBe(3 / elapsedMinutes);
    } finally {
      handle.close();
    }
  });

  test('keeps the top five dimensions and folds remaining successful models into Other', () => {
    const { handle, store } = makeStore();
    try {
      for (let index = 0; index < 6; index += 1) {
        complete(
          store,
          `${index}`.padEnd(32, '0'),
          new Date(NOW.getTime() - 60_000),
          new Date(NOW.getTime() - 1000),
          {
            finalProviderId: `provider-${index}`,
            finalModelId: `model-${index}`,
            finalHttpStatus: 200,
            usage: {
              providerId: `provider-${index}`,
              modelId: `model-${index}`,
              inputTokens: 6 - index,
              outputTokens: 0,
              totalTokens: 6 - index,
            },
          },
          { 'gen_ai.response.model': `model-${index}` },
        );
      }

      const overview = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now: NOW });
      expect(overview.series).toEqual([
        { key: 'model-0', kind: 'dimension' },
        { key: 'model-1', kind: 'dimension' },
        { key: 'model-2', kind: 'dimension' },
        { key: 'model-3', kind: 'dimension' },
        { key: 'model-4', kind: 'dimension' },
        { key: '__other__', kind: 'other' },
      ]);
      expect(overview.buckets.flatMap(({ values }) => [values.__other__]).filter((value) => value !== '0')).toEqual([
        '1',
      ]);
    } finally {
      handle.close();
    }
  });
});
