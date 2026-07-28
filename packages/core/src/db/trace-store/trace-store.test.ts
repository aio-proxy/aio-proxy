import { describe, expect, test } from 'bun:test';

import { usageDaily } from '../schema';
import { createTraceStore } from './index';
import { openTestDb } from './test-support';
import { attemptSpan, completion, ROOT_SPAN_ID, rootSpan, rootStart, TRACE_ID } from './trace-store.test-support';

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

  test('list orders roots by startedAt descending and filters by request id', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const t1 = '1'.repeat(32);
      const t2 = '2'.repeat(32);
      store.startRoot(
        rootStart({
          traceId: t1,
          spanId: t1.slice(0, 16),
          requestId: 'req-1',
          startedAt: new Date('2026-07-24T10:00:00.000Z'),
        }),
      );
      store.startRoot(
        rootStart({
          traceId: t2,
          spanId: t2.slice(0, 16),
          requestId: 'req-2',
          startedAt: new Date('2026-07-24T11:00:00.000Z'),
        }),
      );

      const all = store.list({ page: 1, pageSize: 10 });
      expect(all.items.map((item) => item.requestId)).toEqual(['req-2', 'req-1']);

      const filtered = store.list({ page: 1, pageSize: 10, requestId: 'req-1' });
      expect(filtered.items.map((item) => item.requestId)).toEqual(['req-1']);
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
