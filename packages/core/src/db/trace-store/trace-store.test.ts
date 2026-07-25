import { describe, expect, test } from 'bun:test';

import { usageDaily } from '../schema';
import { createTraceStore } from './index';
import { openTestDb } from './test-support';
import type { StoredSpan, TraceCompletion, TraceRootStart } from './types';

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const CHILD_SPAN_ID = 'c'.repeat(16);
const STARTED_AT = new Date('2026-07-24T10:00:00.000Z');
const ENDED_AT = new Date('2026-07-24T10:00:00.100Z');

function rootStart(overrides: Partial<TraceRootStart> = {}): TraceRootStart {
  const requestId = overrides.requestId ?? 'request-a';
  return {
    ...overrides,
    traceId: overrides.traceId ?? TRACE_ID,
    spanId: overrides.spanId ?? ROOT_SPAN_ID,
    requestId,
    inboundProtocol: overrides.inboundProtocol ?? 'openai-compatible',
    name: overrides.name ?? 'aio_proxy.request',
    kind: overrides.kind ?? 1,
    startedAt: overrides.startedAt ?? STARTED_AT,
    statusCode: overrides.statusCode ?? 0,
    attributes: {
      'aio_proxy.request.id': requestId,
      'aio_proxy.protocol.inbound': 'openai-compatible',
      ...overrides.attributes,
    },
    events: overrides.events ?? [],
    links: overrides.links ?? [],
  };
}

function rootSpan(overrides: Partial<StoredSpan> = {}): StoredSpan {
  return {
    traceId: TRACE_ID,
    spanId: ROOT_SPAN_ID,
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    statusCode: 0,
    attributes: {
      'aio_proxy.request.id': 'request-a',
      'aio_proxy.protocol.inbound': 'openai-compatible',
      'gen_ai.response.model': 'model-b',
      'aio_proxy.route.final_provider_id': 'provider-b',
    },
    events: [],
    links: [],
    ...overrides,
  };
}

function attemptSpan(overrides: Partial<StoredSpan> = {}): StoredSpan {
  return {
    traceId: TRACE_ID,
    spanId: CHILD_SPAN_ID,
    parentSpanId: ROOT_SPAN_ID,
    name: 'aio_proxy.provider.attempt',
    kind: 2,
    startedAt: STARTED_AT,
    endedAt: ENDED_AT,
    statusCode: 0,
    attributes: {
      'aio_proxy.attempt.index': 0,
      'aio_proxy.provider.id': 'provider-b',
      'gen_ai.request.model': 'model-b',
    },
    events: [],
    links: [],
    ...overrides,
  };
}

function completion(overrides: Partial<TraceCompletion> = {}): TraceCompletion {
  return {
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    spans: [rootSpan(), attemptSpan()],
    summary: {
      finalProviderId: 'provider-b',
      finalModelId: 'model-b',
      finalHttpStatus: 200,
      usage: { providerId: 'provider-b', modelId: 'model-b', inputTokens: 10, outputTokens: 5 },
    },
    ...overrides,
  };
}

describe('trace store lifecycle', () => {
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
        },
        spans: [{ name: 'aio_proxy.request' }, { name: 'aio_proxy.provider.attempt' }],
      });

      const rows = handle.db.select().from(usageDaily).all();
      expect(rows).toEqual([
        expect.objectContaining({
          localDay: '2026-07-24',
          modelDimension: 'model-b',
          requestCount: 1,
          successCount: 1,
          inputTokens: 10,
          outputTokens: 5,
        }),
      ]);
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
          requestCount: 2,
          interruptedCount: 2,
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
