import { describe, expect, test } from 'bun:test';

import { usageDaily } from '../schema';
import { createTraceStore, decodeTraceCursor, encodeTraceCursor } from './index';
import { openTestDb } from './test-support';
import { attemptSpan, completion, ROOT_SPAN_ID, rootSpan, rootStart, TRACE_ID } from './trace-store.test-support';
import type { TraceStore } from './types';

describe('trace cursor codec', () => {
  test('round-trips a versioned opaque cursor and rejects malformed tokens', () => {
    const cursor = {
      direction: 'older' as const,
      startedAt: new Date('2026-07-24T11:00:00.000Z'),
      traceId: 'a'.repeat(32),
    };
    const token = encodeTraceCursor(cursor);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(decodeTraceCursor(token)).toEqual(cursor);

    const unsupportedVersion = Buffer.from(
      JSON.stringify({
        version: 2,
        direction: 'older',
        startedAt: '2026-07-24T11:00:00.000Z',
        traceId: 'a'.repeat(32),
      }),
    ).toString('base64url');
    const invalidDate = Buffer.from(
      JSON.stringify({ version: 1, direction: 'older', startedAt: 'not-a-date', traceId: 'a'.repeat(32) }),
    ).toString('base64url');

    expect(decodeTraceCursor('')).toBeUndefined();
    expect(decodeTraceCursor('not+base64url')).toBeUndefined();
    expect(decodeTraceCursor(Buffer.from('not-json').toString('base64url'))).toBeUndefined();
    expect(decodeTraceCursor(unsupportedVersion)).toBeUndefined();
    expect(decodeTraceCursor(invalidDate)).toBeUndefined();
  });
});

describe('trace store lifecycle', () => {
  test('uses the supplied clock for running trace durations', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());

      const detail = store.find(TRACE_ID, new Date('2026-07-24T10:00:00.250Z'));
      expect(detail?.trace).toMatchObject({ endedAt: null, durationMs: 250 });
      expect(detail?.spans).toEqual([expect.objectContaining({ endedAt: null, durationMs: 250 })]);
    } finally {
      handle.close();
    }
  });

  test('persists root and children atomically with first-transition semantics', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(store.find(TRACE_ID)?.trace.endedAt).toBeNull();

      expect(store.complete(completion())).toBe(true);
      expect(store.complete(completion())).toBe(false);

      const detail = store.find(TRACE_ID);
      expect(detail).toMatchObject({
        trace: {
          traceId: TRACE_ID,
          requestId: 'request-a',
          finalProviderId: 'provider-b',
          finalModelId: 'model-b',
          usage: { estimatedCostUsd: 0.1 },
        },
        spans: [{ name: 'aio_proxy.request' }, { name: 'aio_proxy.provider.attempt' }],
      });

      const rows = handle.db.select().from(usageDaily).all();
      expect(rows).toEqual([
        expect.objectContaining({
          localDay: '2026-07-24',
          modelDimension: 'model-b',
          requestCount: '1',
          usageRequestCount: '1',
          pricedRequestCount: '1',
          successCount: '1',
          inputTokens: '10',
          outputTokens: '5',
          totalTokens: '20',
          estimatedCostNanoUsd: '100000000',
        }),
      ]);

      const totalTraceId = 'd'.repeat(32);
      const totalSpanId = 'e'.repeat(16);
      store.startRoot(rootStart({ traceId: totalTraceId, spanId: totalSpanId, requestId: 'request-total' }));
      expect(
        store.complete(
          completion({
            traceId: totalTraceId,
            rootSpanId: totalSpanId,
            spans: [
              rootSpan({
                traceId: totalTraceId,
                spanId: totalSpanId,
                attributes: { 'aio_proxy.request.id': 'request-total' },
              }),
            ],
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'model-total',
              usage: { providerId: 'provider-b', modelId: 'model-total', totalTokens: 42 },
            },
          }),
        ),
      ).toBe(true);
      expect(handle.db.select().from(usageDaily).all()).toContainEqual(
        expect.objectContaining({ modelDimension: 'model-total', usageRequestCount: '1', totalTokens: '42' }),
      );
    } finally {
      handle.close();
    }
  });

  test('rolls usage up under the requested model alias, not the upstream model', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      expect(
        store.complete(
          completion({
            session: {
              identity: { source: 'body-session', id: 'session-a' },
              requestedModelId: 'my-alias',
              resolvedBy: 'body-session',
            },
            summary: {
              finalProviderId: 'provider-b',
              finalModelId: 'upstream-model',
              usage: { providerId: 'provider-b', modelId: 'upstream-model', totalTokens: 7 },
            },
          }),
        ),
      ).toBe(true);

      expect(handle.db.select().from(usageDaily).all()).toContainEqual(
        expect.objectContaining({ modelDimension: 'my-alias', requestCount: '1', totalTokens: '7' }),
      );
    } finally {
      handle.close();
    }
  });

  test('projects root stream intent and TTFT into trace summaries', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      store.complete(
        completion({
          spans: [
            rootSpan({
              attributes: {
                'aio_proxy.request.id': 'request-a',
                'aio_proxy.protocol.inbound': 'openai-compatible',
                'aio_proxy.request.stream': true,
                'aio_proxy.response.ttft_ms': 42,
              },
            }),
          ],
        }),
      );

      expect(store.find(TRACE_ID)?.trace).toMatchObject({ stream: true, ttftMs: 42 });
    } finally {
      handle.close();
    }
  });

  test('projects root fast-mode intent into trace summaries', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());
      store.complete(
        completion({
          spans: [
            rootSpan({
              attributes: {
                'aio_proxy.request.id': 'request-a',
                'aio_proxy.protocol.inbound': 'openai-compatible',
                'aio_proxy.request.fast': true,
              },
            }),
          ],
        }),
      );

      expect(store.find(TRACE_ID)?.trace).toMatchObject({ fast: true });
    } finally {
      handle.close();
    }
  });

  test('rolls back the terminal transaction when a child violates the parent foreign key', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());

      const bad = completion({
        spans: [rootSpan(), attemptSpan({ spanId: 'd'.repeat(16), parentSpanId: 'e'.repeat(16) })],
      });
      expect(() => store.complete(bad)).toThrow();

      expect(store.find(TRACE_ID)?.trace.endedAt).toBeNull();
      expect(handle.db.select().from(usageDaily).all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  test('throws before mutating state when usage provider/model do not match the final route', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());

      const bad = completion({
        summary: {
          finalProviderId: 'provider-b',
          finalModelId: 'model-b',
          usage: { providerId: 'other', modelId: 'model-b', inputTokens: 1 },
        },
      });
      expect(() => store.complete(bad)).toThrow();
      expect(store.find(TRACE_ID)?.trace.endedAt).toBeNull();
    } finally {
      handle.close();
    }
  });

  test.each(['failure', 'cancelled', 'interrupted'] as const)(
    'throws before mutating state when a %s completion includes usage',
    (terminationReason) => {
      const handle = openTestDb();
      try {
        const store = createTraceStore(handle.db);
        store.startRoot(rootStart());

        const bad = completion({
          summary: {
            finalProviderId: 'provider-b',
            finalModelId: 'model-b',
            terminationReason,
            usage: { providerId: 'provider-b', modelId: 'model-b', inputTokens: 1 },
          },
        });
        expect(() => store.complete(bad)).toThrow();
        expect(store.find(TRACE_ID)?.trace.endedAt).toBeNull();
        expect(handle.db.select().from(usageDaily).all()).toEqual([]);
      } finally {
        handle.close();
      }
    },
  );

  test('throws before mutating state when sessionState is present without session', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart());

      const bad = completion({
        sessionState: { responseId: 'resp-1' },
      });
      expect(() => store.complete(bad)).toThrow();
      expect(store.find(TRACE_ID)?.trace.endedAt).toBeNull();
    } finally {
      handle.close();
    }
  });
});

describe('trace store recover, list, and prune', () => {
  test('recover marks running roots as interrupted and is idempotent', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot(rootStart({ traceId: TRACE_ID, spanId: ROOT_SPAN_ID }));
      store.startRoot(rootStart({ traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), requestId: 'request-b' }));

      const now = new Date('2026-07-24T11:00:00.000Z');
      expect(store.recover(now)).toBe(2);
      expect(store.recover(now)).toBe(0);

      const detail = store.find(TRACE_ID);
      expect(detail?.trace.endedAt).toBe(now.toISOString());
      expect(detail?.trace.terminationReason).toBe('interrupted');

      const rows = handle.db.select().from(usageDaily).all();
      expect(rows).toEqual([
        expect.objectContaining({
          localDay: '2026-07-24',
          modelDimension: 'unknown',
          requestCount: '2',
          interruptedCount: '2',
        }),
      ]);
    } finally {
      handle.close();
    }
  });

  test('list traverses adjacent pages in both directions with stable timestamp tie-breaking', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const rows = [
        { traceId: 'd'.repeat(32), requestId: 'req-13', startedAt: '2026-07-24T13:00:00.000Z' },
        { traceId: 'c'.repeat(32), requestId: 'req-12', startedAt: '2026-07-24T12:00:00.000Z' },
        { traceId: 'b'.repeat(32), requestId: 'req-11', startedAt: '2026-07-24T11:00:00.000Z' },
        { traceId: 'a'.repeat(32), requestId: 'req-10', startedAt: '2026-07-24T10:00:00.000Z' },
        { traceId: '9'.repeat(32), requestId: 'req-9', startedAt: '2026-07-24T09:00:00.000Z' },
        { traceId: '8'.repeat(32), requestId: 'req-8', startedAt: '2026-07-24T08:00:00.000Z' },
        { traceId: '7'.repeat(32), requestId: 'req-7', startedAt: '2026-07-24T07:00:00.000Z' },
        { traceId: '6'.repeat(32), requestId: 'req-6', startedAt: '2026-07-24T06:00:00.000Z' },
        { traceId: '5'.repeat(32), requestId: 'req-5', startedAt: '2026-07-24T05:00:00.000Z' },
        { traceId: 'f'.repeat(32), requestId: 'req-4-f', startedAt: '2026-07-24T04:00:00.000Z' },
        { traceId: 'e'.repeat(32), requestId: 'req-4-e', startedAt: '2026-07-24T04:00:00.000Z' },
        { traceId: '3'.repeat(32), requestId: 'req-3', startedAt: '2026-07-24T03:00:00.000Z' },
        { traceId: '2'.repeat(32), requestId: 'req-2', startedAt: '2026-07-24T02:00:00.000Z' },
        { traceId: '1'.repeat(32), requestId: 'req-1', startedAt: '2026-07-24T01:00:00.000Z' },
      ] as const;
      for (const row of rows) {
        store.startRoot(rootStart({ ...row, spanId: row.traceId.slice(0, 16), startedAt: new Date(row.startedAt) }));
      }

      const latest = store.list({ pageSize: 10 });
      expect(latest.items.map((item) => item.requestId)).toEqual([
        'req-13',
        'req-12',
        'req-11',
        'req-10',
        'req-9',
        'req-8',
        'req-7',
        'req-6',
        'req-5',
        'req-4-f',
      ]);
      expect(latest.previousCursor).toBeUndefined();
      expect(latest.nextCursor).toBeDefined();

      const oldest = store.list({ pageSize: 10, cursor: latest.nextCursor });
      expect(oldest.items.map((item) => item.requestId)).toEqual(['req-4-e', 'req-3', 'req-2', 'req-1']);
      expect(oldest.previousCursor).toBeDefined();
      expect(oldest.nextCursor).toBeUndefined();

      const returnedLatest = store.list({ pageSize: 10, cursor: oldest.previousCursor });
      expect(returnedLatest.items.map((item) => item.requestId)).toEqual(latest.items.map((item) => item.requestId));
      expect(returnedLatest.previousCursor).toBeUndefined();
      expect(returnedLatest.nextCursor).toBeDefined();

      const filtered = store.list({ pageSize: 10, requestId: 'req-1' });
      expect(filtered.items.map((item) => item.requestId)).toEqual(['req-1']);
      expect(filtered.previousCursor).toBeUndefined();
      expect(filtered.nextCursor).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test('list keeps older traversal stable when a newer root is inserted', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const rows = [
        { traceId: 'b'.repeat(32), requestId: 'req-11', startedAt: '2026-07-24T11:00:00.000Z' },
        { traceId: 'a'.repeat(32), requestId: 'req-10', startedAt: '2026-07-24T10:00:00.000Z' },
        { traceId: '9'.repeat(32), requestId: 'req-9', startedAt: '2026-07-24T09:00:00.000Z' },
        { traceId: '8'.repeat(32), requestId: 'req-8', startedAt: '2026-07-24T08:00:00.000Z' },
        { traceId: '7'.repeat(32), requestId: 'req-7', startedAt: '2026-07-24T07:00:00.000Z' },
        { traceId: '6'.repeat(32), requestId: 'req-6', startedAt: '2026-07-24T06:00:00.000Z' },
        { traceId: '5'.repeat(32), requestId: 'req-5', startedAt: '2026-07-24T05:00:00.000Z' },
        { traceId: '4'.repeat(32), requestId: 'req-4', startedAt: '2026-07-24T04:00:00.000Z' },
        { traceId: '3'.repeat(32), requestId: 'req-3', startedAt: '2026-07-24T03:00:00.000Z' },
        { traceId: '2'.repeat(32), requestId: 'req-2', startedAt: '2026-07-24T02:00:00.000Z' },
        { traceId: '1'.repeat(32), requestId: 'req-1', startedAt: '2026-07-24T01:00:00.000Z' },
      ] as const;
      for (const row of rows) {
        store.startRoot(rootStart({ ...row, spanId: row.traceId.slice(0, 16), startedAt: new Date(row.startedAt) }));
      }

      const latest = store.list({ pageSize: 10 });
      expect(latest.nextCursor).toBeDefined();

      const insertedTraceId = 'c'.repeat(32);
      store.startRoot(
        rootStart({
          traceId: insertedTraceId,
          spanId: insertedTraceId.slice(0, 16),
          requestId: 'req-12',
          startedAt: new Date('2026-07-24T12:00:00.000Z'),
        }),
      );

      const oldest = store.list({ pageSize: 10, cursor: latest.nextCursor });
      expect(oldest.items.map((item) => item.requestId)).toEqual(['req-1']);

      const returnedPage = store.list({ pageSize: 10, cursor: oldest.previousCursor });
      expect(returnedPage.items.map((item) => item.requestId)).toEqual(latest.items.map((item) => item.requestId));
      expect(returnedPage.previousCursor).toBeDefined();
    } finally {
      handle.close();
    }
  });

  test('prune removes old completed roots and expired session state but keeps running roots', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const oldTrace = 'a'.repeat(32);
      const newTrace = 'b'.repeat(32);
      const oldStart = new Date('2026-06-01T10:00:00.000Z');
      const oldEnd = new Date('2026-06-01T10:00:00.100Z');
      const newStart = new Date('2026-07-24T10:00:00.000Z');

      store.startRoot(
        rootStart({ traceId: oldTrace, spanId: oldTrace.slice(0, 16), requestId: 'req-old', startedAt: oldStart }),
      );
      store.complete({
        traceId: oldTrace,
        rootSpanId: oldTrace.slice(0, 16),
        spans: [
          {
            traceId: oldTrace,
            spanId: oldTrace.slice(0, 16),
            name: 'aio_proxy.request',
            kind: 1,
            startedAt: oldStart,
            endedAt: oldEnd,
            statusCode: 0,
            attributes: {},
            events: [],
            links: [],
          },
        ],
        summary: { finalProviderId: 'p', finalModelId: 'm', finalHttpStatus: 200 },
      });

      store.startRoot(
        rootStart({ traceId: newTrace, spanId: newTrace.slice(0, 16), requestId: 'req-new', startedAt: newStart }),
      );

      store.prune(new Date('2026-07-01T00:00:00.000Z'), new Date('2026-07-01T00:00:00.000Z'));

      expect(store.find(oldTrace)).toBeUndefined();
      expect(store.find(newTrace)).toBeDefined();
    } finally {
      handle.close();
    }
  });
});

// 真实的成功调用链是 ended + UNSET：链路上没有任何地方把根 span 设成 OK，所以这里也
// 不许按 statusCode 播种，否则测试会自己造出一种生产里不存在的形状。
const seedTrace = (
  store: TraceStore,
  traceId: string,
  startedAt: string,
  outcome: 'success' | 'error' | 'running',
): void => {
  const spanId = traceId.slice(0, 16);
  const requestId = `req-${traceId.slice(0, 4)}`;
  const at = new Date(startedAt);
  store.startRoot(rootStart({ traceId, spanId, requestId, startedAt: at }));
  // 只 startRoot 不 complete，就是一条还在跑的调用链
  if (outcome === 'running') return;
  const failed = outcome === 'error';
  store.complete(
    completion({
      traceId,
      rootSpanId: spanId,
      spans: [
        rootSpan({
          traceId,
          spanId,
          startedAt: at,
          endedAt: new Date(at.getTime() + 100),
          statusCode: failed ? 2 : 0,
          ...(failed ? { terminationReason: 'failure' as const } : {}),
          // request_id 是唯一列，每条种子调用链都要带上自己的那个
          attributes: { 'aio_proxy.request.id': requestId },
        }),
      ],
      summary: {
        finalProviderId: 'provider-b',
        finalModelId: 'model-b',
        finalHttpStatus: failed ? 500 : 200,
      },
    }),
  );
};

describe('trace store summary', () => {
  test('buckets success and error counts from the range start and leaves running traces out', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T09:00:10.000Z', 'success');
      seedTrace(store, '2'.repeat(32), '2026-07-24T09:00:40.000Z', 'success');
      seedTrace(store, '3'.repeat(32), '2026-07-24T09:00:50.000Z', 'error');
      seedTrace(store, '4'.repeat(32), '2026-07-24T09:30:05.000Z', 'error');
      seedTrace(store, '5'.repeat(32), '2026-07-24T09:45:00.000Z', 'running');

      const result = store.summary({
        startedAfter: new Date('2026-07-24T09:00:00.000Z'),
        startedBefore: new Date('2026-07-24T10:00:00.000Z'),
      });

      expect(result.bucket).toBe('1m');
      expect(result.buckets).toHaveLength(60);
      expect(result.buckets[0]).toEqual({ at: '2026-07-24T09:00:00.000Z', success: 2, error: 1 });
      expect(result.buckets[1]).toEqual({ at: '2026-07-24T09:01:00.000Z', success: 0, error: 0 });
      expect(result.buckets[30]).toEqual({ at: '2026-07-24T09:30:00.000Z', success: 0, error: 1 });
      // 那条还在跑的落在 09:45 桶里，两边都不该数它
      expect(result.buckets[45]).toEqual({ at: '2026-07-24T09:45:00.000Z', success: 0, error: 0 });
      expect(result.totals).toEqual({ success: 2, error: 2 });
    } finally {
      handle.close();
    }
  });

  // startedBefore 是闭区间：正好落在末端的那条算出来的桶号是 count，越界一格。不夹一刀
  // 它就会连 totals 一起被悄悄丢掉 —— 图上少一条、总数也少一条，而没有任何报错。
  test('keeps a trace that lands exactly on the closed upper bound', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T10:00:00.000Z', 'success');

      const result = store.summary({
        startedAfter: new Date('2026-07-24T09:00:00.000Z'),
        startedBefore: new Date('2026-07-24T10:00:00.000Z'),
      });

      expect(result.totals).toEqual({ success: 1, error: 0 });
      expect(result.buckets.at(-1)).toEqual({ at: '2026-07-24T09:59:00.000Z', success: 1, error: 0 });
    } finally {
      handle.close();
    }
  });

  test('reuses the list filters', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T09:00:10.000Z', 'success');
      seedTrace(store, '2'.repeat(32), '2026-07-24T09:00:40.000Z', 'error');
      const range = {
        startedAfter: new Date('2026-07-24T09:00:00.000Z'),
        startedBefore: new Date('2026-07-24T10:00:00.000Z'),
      };

      expect(store.summary({ ...range, otelStatusCode: 'ERROR' }).totals).toEqual({ success: 0, error: 1 });
      expect(store.summary({ ...range, finalProviderId: 'provider-nope' }).totals).toEqual({ success: 0, error: 0 });
    } finally {
      handle.close();
    }
  });

  test('counts the same traces the outcome filter selects', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T09:00:10.000Z', 'success');
      seedTrace(store, '2'.repeat(32), '2026-07-24T09:00:40.000Z', 'error');
      seedTrace(store, '3'.repeat(32), '2026-07-24T09:00:50.000Z', 'running');
      const range = {
        startedAfter: new Date('2026-07-24T09:00:00.000Z'),
        startedBefore: new Date('2026-07-24T10:00:00.000Z'),
      };

      // 图上写着几个成功，点掉图例就得列出那几条。两处各判一次成败就是 0 成功那个 bug。
      expect(store.summary(range).totals).toEqual({ success: 1, error: 1 });
      expect(store.list({ ...range, pageSize: 50, outcome: 'success' }).items).toHaveLength(1);
      expect(store.list({ ...range, pageSize: 50, outcome: 'error' }).items).toHaveLength(1);
    } finally {
      handle.close();
    }
  });

  test('coarsens the bucket as the range widens', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const startedAfter = new Date('2026-06-24T00:00:00.000Z');
      const at = (days: number) => new Date(startedAfter.getTime() + days * 86_400_000);

      // 3h 正好是 180 个 1m 桶，也就是上界本身：闭区间，还该选最细的那一档。
      expect(store.summary({ startedAfter, startedBefore: at(0.125) }).bucket).toBe('1m');
      expect(store.summary({ startedAfter, startedBefore: at(0.25) }).bucket).toBe('5m');
      expect(store.summary({ startedAfter, startedBefore: at(1) }).bucket).toBe('30m');
      expect(store.summary({ startedAfter, startedBefore: at(7) }).bucket).toBe('1h');
      const retention = store.summary({ startedAfter, startedBefore: at(45) });
      expect(retention.bucket).toBe('1d');
      expect(retention.buckets).toHaveLength(45);
    } finally {
      handle.close();
    }
  });

  test('keeps the bucket array bounded for an absurd range', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      seedTrace(store, '1'.repeat(32), '2026-07-24T09:00:10.000Z', 'success');

      // 年份是客户端传进来的，0000→9999 按 1d 一桶就是三百多万个桶
      const result = store.summary({
        startedAfter: new Date('0000-01-01T00:00:00.000Z'),
        startedBefore: new Date('9999-12-31T23:59:59.000Z'),
      });

      // 上界是多少不重要，重要的是有上界，而且跨度再离谱也不会跟着涨
      expect(result.buckets.length).toBeLessThan(1000);
      expect(result.bucket).toBe('1d');
      const wider = store.summary({
        startedAfter: new Date('0000-01-01T00:00:00.000Z'),
        startedBefore: new Date('9999-12-31T23:59:59.999Z'),
      });
      expect(wider.buckets).toHaveLength(result.buckets.length);
      // 每个桶的 at 还是真实的 1d 间隔，宽度没有为了收敛而被偷偷拉大
      expect(Date.parse(result.buckets[1]!.at) - Date.parse(result.buckets[0]!.at)).toBe(86_400_000);
      // 窗口被截断了，落在窗口外的调用链不能被塞进最后一个桶
      expect(result.totals).toEqual({ success: 0, error: 0 });
    } finally {
      handle.close();
    }
  });
});
