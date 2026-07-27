import { describe, expect, test } from 'bun:test';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import { attemptSpan, completion, rootSpan, rootStart } from '../trace-store.test-support';

const SQLITE_INTEGER_MAX = '9223372036854775807';
const SQLITE_INTEGER_PLUS_ONE = '9223372036854775808';

describe('trace usage persistence', () => {
  test('adds daily fallback tokens exactly in SQLite', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(
        store.complete(
          completion({
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'model-b',
              finalHttpStatus: 200,
              usage: {
                providerId: 'provider-b',
                modelId: 'model-b',
                inputTokens: Number.MAX_SAFE_INTEGER,
                outputTokens: 2,
              },
            },
          }),
        ),
      ).toBe(true);

      const row = handle.sqlite
        .query<{ totalTokens: string }, []>('select cast(total_tokens as text) as totalTokens from usage_daily')
        .get();
      expect(row?.totalTokens).toBe('9007199254740993');
    } finally {
      handle.close();
    }
  });

  test('does not count provider and model metadata as usage', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(
        store.complete(
          completion({
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'model-b',
              finalHttpStatus: 200,
              usage: { providerId: 'provider-b', modelId: 'model-b' },
            },
          }),
        ),
      ).toBe(true);

      const row = handle.sqlite
        .query<{ totalTokens: string; usageRequestCount: string }, []>(
          'select cast(total_tokens as text) as totalTokens, cast(usage_request_count as text) as usageRequestCount from usage_daily',
        )
        .get();
      expect(row).toEqual({ totalTokens: '0', usageRequestCount: '0' });
    } finally {
      handle.close();
    }
  });

  test('keeps daily token and cost totals exact after trace pruning', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(store.complete(completion())).toBe(true);
      handle.sqlite
        .query('update usage_daily set input_tokens = ?, estimated_cost_nano_usd = ?')
        .run(SQLITE_INTEGER_MAX, SQLITE_INTEGER_MAX);

      const traceId = 'd'.repeat(32);
      const rootSpanId = 'e'.repeat(16);
      store.startRoot(
        rootStart({
          traceId,
          spanId: rootSpanId,
          requestId: 'request-b',
          attributes: { 'aio_proxy.request.id': 'request-b', 'aio_proxy.protocol.inbound': 'openai-compatible' },
        }),
      );
      expect(
        store.complete(
          completion({
            traceId,
            rootSpanId,
            spans: [
              rootSpan({
                traceId,
                spanId: rootSpanId,
                attributes: { 'aio_proxy.request.id': 'request-b', 'aio_proxy.protocol.inbound': 'openai-compatible' },
              }),
              attemptSpan({ traceId, spanId: 'f'.repeat(16), parentSpanId: rootSpanId }),
            ],
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'model-b',
              finalHttpStatus: 200,
              usage: { providerId: 'provider-b', modelId: 'model-b', inputTokens: 1, estimatedCostUsd: 0.000000001 },
            },
          }),
        ),
      ).toBe(true);

      store.prune(new Date('2026-07-25T00:00:00.000Z'), new Date('2026-07-25T00:00:00.000Z'));
      expect(store.find(traceId)).toBeUndefined();
      const row = handle.sqlite
        .query<{ inputTokensType: string; inputTokens: string; estimatedCostType: string; estimatedCost: string }, []>(
          'select typeof(input_tokens) as inputTokensType, cast(input_tokens as text) as inputTokens, typeof(estimated_cost_nano_usd) as estimatedCostType, cast(estimated_cost_nano_usd as text) as estimatedCost from usage_daily',
        )
        .get();
      expect(row).toEqual({
        inputTokensType: 'text',
        inputTokens: SQLITE_INTEGER_PLUS_ONE,
        estimatedCostType: 'text',
        estimatedCost: SQLITE_INTEGER_PLUS_ONE,
      });
    } finally {
      handle.close();
    }
  });

  test('keeps recovered interrupted counts exact beyond SQLite integers', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(store.complete(completion({ summary: {} }))).toBe(true);
      handle.sqlite
        .query("update usage_daily set request_count = ?, interrupted_count = ? where model_dimension = 'unknown'")
        .run(SQLITE_INTEGER_MAX, SQLITE_INTEGER_MAX);

      store.startRoot(
        rootStart({
          traceId: 'd'.repeat(32),
          spanId: 'e'.repeat(16),
          requestId: 'request-b',
          attributes: { 'aio_proxy.request.id': 'request-b', 'aio_proxy.protocol.inbound': 'openai-compatible' },
        }),
      );
      expect(store.recover(new Date('2026-07-24T10:00:00.100Z'))).toBe(1);

      const row = handle.sqlite
        .query<
          { requestCountType: string; requestCount: string; interruptedCountType: string; interruptedCount: string },
          []
        >(
          "select typeof(request_count) as requestCountType, cast(request_count as text) as requestCount, typeof(interrupted_count) as interruptedCountType, cast(interrupted_count as text) as interruptedCount from usage_daily where model_dimension = 'unknown'",
        )
        .get();
      expect(row).toEqual({
        requestCountType: 'text',
        requestCount: SQLITE_INTEGER_PLUS_ONE,
        interruptedCountType: 'text',
        interruptedCount: SQLITE_INTEGER_PLUS_ONE,
      });
    } finally {
      handle.close();
    }
  });

  test('migrates all usage daily rollups to decimal text', () => {
    const handle = openTestDb();
    try {
      const rollupColumns = [
        'request_count',
        'success_count',
        'error_count',
        'cancelled_count',
        'interrupted_count',
        'usage_request_count',
        'priced_request_count',
        'input_tokens',
        'output_tokens',
        'total_tokens',
        'cache_read_tokens',
        'cache_write_tokens',
        'reasoning_tokens',
        'estimated_cost_nano_usd',
      ];
      const columns = handle.sqlite.query<{ name: string; type: string; defaultValue: string }, []>(
        "select name, type, dflt_value as defaultValue from pragma_table_info('usage_daily')",
      );

      expect(columns.all()).toEqual(
        expect.arrayContaining(rollupColumns.map((name) => ({ name, type: 'TEXT', defaultValue: "'0'" }))),
      );
    } finally {
      handle.close();
    }
  });
});
