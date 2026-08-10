import { describe, expect, test } from 'bun:test';

import { DashboardUsageOverviewResponseSchema } from '@aio-proxy/types';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { completion, rootSpan, rootStart } from '../trace-store.test-support';
import type { TraceCompletion } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');

function makeStore() {
  const handle = openTestDb();
  return { handle, store: createTraceStore(handle.db) };
}

function complete(
  store: ReturnType<typeof createTraceStore>,
  traceId: string,
  summary: TraceCompletion['summary'],
): void {
  const startedAt = new Date(NOW.getTime() - 2000);
  const spanId = traceId.slice(0, 16);
  const attrs: Record<string, unknown> = { 'aio_proxy.protocol.inbound': 'openai-compatible' };
  if (summary.finalProviderId !== undefined) attrs['aio_proxy.route.final_provider_id'] = summary.finalProviderId;
  if (summary.finalModelId !== undefined) attrs['gen_ai.response.model'] = summary.finalModelId;
  if (summary.usage?.inputTokens !== undefined) attrs['gen_ai.usage.input_tokens'] = summary.usage.inputTokens;
  if (summary.usage?.outputTokens !== undefined) attrs['gen_ai.usage.output_tokens'] = summary.usage.outputTokens;
  if (summary.usage?.totalTokens !== undefined) attrs['gen_ai.usage.total_tokens'] = summary.usage.totalTokens;
  if (summary.usage?.estimatedCostUsd !== undefined)
    attrs['gen_ai.usage.estimated_cost_usd'] = summary.usage.estimatedCostUsd;
  store.startRoot(
    rootStart({
      traceId,
      spanId,
      requestId: `req-${traceId}`,
      startedAt,
      attributes: attrs,
    }),
  );
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [rootSpan({ traceId, spanId, startedAt, endedAt: NOW, attributes: attrs })],
      summary,
    }),
  );
}

function bucketTotal(buckets: readonly { readonly values: Readonly<Record<string, string | number>> }[]): bigint {
  return buckets
    .flatMap(({ values }) => Object.values(values))
    .reduce((total, value) => total + BigInt(String(value)), 0n);
}

describe('exact usage overview aggregation', () => {
  test('preserves totals above Number.MAX_SAFE_INTEGER and counts total-only usage', () => {
    const { handle, store } = makeStore();
    try {
      complete(store, 'a'.repeat(32), {
        finalProviderId: 'provider',
        finalModelId: 'model',
        finalHttpStatus: 200,
        usage: {
          providerId: 'provider',
          modelId: 'model',
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 4_503_599_627_370_496,
        },
      });
      complete(store, 'b'.repeat(32), {
        finalProviderId: 'provider',
        finalModelId: 'model',
        finalHttpStatus: 200,
        usage: { providerId: 'provider', modelId: 'model', totalTokens: 4_503_599_627_370_497 },
      });

      const overview = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now: NOW });

      expect(overview.summary.usageRequestCount).toBe('2');
      expect(overview.summary.totalTokens).toBe('9007199254740993');
      expect(bucketTotal(overview.buckets)).toBe(9_007_199_254_740_993n);
    } finally {
      handle.close();
    }
  });

  test('aggregates nano-USD costs without floating point loss', () => {
    const { handle, store } = makeStore();
    try {
      for (const [index, estimatedCostUsd] of [0.1, 0.2, 0.000_000_002].entries()) {
        complete(store, `${index}`.padEnd(32, 'c'), {
          finalProviderId: 'provider',
          finalModelId: 'model',
          finalHttpStatus: 200,
          usage: { providerId: 'provider', modelId: 'model', estimatedCostUsd },
        });
      }

      const overview = store.overview({ range: '24h', metric: 'cost', groupBy: 'model', now: NOW });

      expect(overview.summary.estimatedCostNanoUsd).toBe('300000002');
      expect(bucketTotal(overview.buckets)).toBe(300_000_002n);
    } finally {
      handle.close();
    }
  });

  test('ranks Top 5 and folds Other with exact bigint totals', () => {
    const { handle, store } = makeStore();
    try {
      const dimensions = [
        ...Array.from(
          { length: 4 },
          (_, index) => [`model-top-${index}`, [4_503_599_627_370_600, 4_503_599_627_370_600]] as const,
        ),
        ['model-z', [4_503_599_627_370_496, 4_503_599_627_370_497]] as const,
        ['model-a', [4_503_599_627_370_496, 4_503_599_627_370_496]] as const,
      ];
      let traceIndex = 0;
      for (const [modelId, totals] of dimensions) {
        for (const totalTokens of totals) {
          complete(store, String(traceIndex++).padStart(32, '0'), {
            finalProviderId: 'provider',
            finalModelId: modelId,
            finalHttpStatus: 200,
            usage: { providerId: 'provider', modelId, totalTokens },
          });
        }
      }

      const overview = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', maxResults: 5, now: NOW });

      expect(overview.series).toEqual([
        { key: 'model-top-0', kind: 'dimension' },
        { key: 'model-top-1', kind: 'dimension' },
        { key: 'model-top-2', kind: 'dimension' },
        { key: 'model-top-3', kind: 'dimension' },
        { key: 'model-z', kind: 'dimension' },
        { key: '__other__', kind: 'other' },
      ]);
      expect(overview.buckets.reduce((total, { values }) => total + BigInt(values.__other__ ?? '0'), 0n)).toBe(
        9_007_199_254_740_992n,
      );
    } finally {
      handle.close();
    }
  });

  test('returns schema-safe buckets for prototype-named dimensions', () => {
    const { handle, store } = makeStore();
    try {
      for (const [index, [modelId, totalTokens]] of [
        ['__proto__', 3],
        ['constructor', 2],
        ['toString', 1],
      ].entries()) {
        complete(store, `${index}`.padEnd(32, 'p'), {
          finalProviderId: 'provider',
          finalModelId: modelId,
          finalHttpStatus: 200,
          usage: { providerId: 'provider', modelId, totalTokens },
        });
      }

      const overview = store.overview({ range: '24h', metric: 'tokens', groupBy: 'model', now: NOW });
      const bucket = overview.buckets.find(({ values }) => values['dimension:__proto__'] !== '0');

      expect(overview.series).toEqual([
        { key: 'dimension:__proto__', kind: 'dimension' },
        { key: 'constructor', kind: 'dimension' },
        { key: 'toString', kind: 'dimension' },
      ]);
      expect(bucket?.values['dimension:__proto__']).toBe('3');
      expect(bucket?.values.constructor).toBe('2');
      expect(bucket?.values.toString).toBe('1');
      expect(DashboardUsageOverviewResponseSchema.parse(overview)).toEqual(overview);
    } finally {
      handle.close();
    }
  });
});
