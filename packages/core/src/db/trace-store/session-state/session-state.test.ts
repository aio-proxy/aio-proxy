import { describe, expect, test } from 'bun:test';

import { sessionAffinity, sessionResponse } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const STARTED_AT = new Date('2026-07-24T10:00:00.000Z');
const ENDED_AT = new Date('2026-07-24T10:00:00.100Z');

function completeWithSession(store: ReturnType<typeof createTraceStore>, responseId?: string, observed?: unknown) {
  return store.complete({
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    spans: [
      {
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        endedAt: ENDED_AT,
        statusCode: 0,
        attributes: { 'aio_proxy.request.id': 'r1', 'aio_proxy.protocol.inbound': 'openai-compatible' },
        events: [],
        links: [],
      },
    ],
    summary: { finalProviderId: 'provider-a', finalModelId: 'model-a', finalHttpStatus: 200 },
    session: {
      identity: { source: 'body-session', id: 'session-1' },
      requestedModelId: 'model-a',
      resolvedBy: 'body-session',
    },
    sessionState: { responseId, observedAffinity: observed as never },
  });
}

describe('session state', () => {
  test('persists hashed response id and slides expiry on resolve', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot({
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        requestId: 'r1',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        statusCode: 0,
        attributes: {},
        events: [],
        links: [],
      });
      completeWithSession(store, '  resp-abc  ');

      const rows = handle.db.select().from(sessionResponse).all();
      expect(rows).toHaveLength(1);
      expect(rows[0].responseIdSha256).not.toBe('resp-abc');
      expect(rows[0].sessionId).toBe('session-1');

      const now = new Date(ENDED_AT.getTime() + 30 * 60 * 1000);
      expect(store.resolveResponse('resp-abc', now)).toEqual({ source: 'body-session', id: 'session-1' });
      const after = handle.db.select().from(sessionResponse).get()!;
      expect(after.expiresAt.getTime()).toBeGreaterThan(now.getTime());
    } finally {
      handle.close();
    }
  });

  test('rejects expired response id', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot({
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        requestId: 'r1',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        statusCode: 0,
        attributes: {},
        events: [],
        links: [],
      });
      completeWithSession(store, 'resp-expired');
      const future = new Date(ENDED_AT.getTime() + 2 * 60 * 60 * 1000);
      expect(store.resolveResponse('resp-expired', future)).toBeUndefined();
    } finally {
      handle.close();
    }
  });

  test('keeps two long response ids sharing the first 512 characters distinct', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const prefix = 'x'.repeat(600);
      store.startRoot({
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        requestId: 'r1',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        statusCode: 0,
        attributes: {},
        events: [],
        links: [],
      });
      completeWithSession(store, `${prefix}A`);
      store.startRoot({
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
        requestId: 'r2',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        statusCode: 0,
        attributes: {},
        events: [],
        links: [],
      });
      store.complete({
        traceId: 'c'.repeat(32),
        rootSpanId: 'd'.repeat(16),
        spans: [
          {
            traceId: 'c'.repeat(32),
            spanId: 'd'.repeat(16),
            name: 'aio_proxy.request',
            kind: 1,
            startedAt: STARTED_AT,
            endedAt: ENDED_AT,
            statusCode: 0,
            attributes: {},
            events: [],
            links: [],
          },
        ],
        summary: { finalProviderId: 'provider-a', finalModelId: 'model-a', finalHttpStatus: 200 },
        session: {
          identity: { source: 'body-session', id: 'session-2' },
          requestedModelId: 'model-a',
          resolvedBy: 'body-session',
        },
        sessionState: { responseId: `${prefix}B` },
      });

      expect(handle.db.select().from(sessionResponse).all()).toHaveLength(2);
    } finally {
      handle.close();
    }
  });

  test('creates affinity on first success and refreshes by revision', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      store.startRoot({
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        requestId: 'r1',
        inboundProtocol: 'openai-compatible',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        statusCode: 0,
        attributes: {},
        events: [],
        links: [],
      });
      completeWithSession(store);

      const affinity = handle.db.select().from(sessionAffinity).get()!;
      expect(affinity.providerId).toBe('provider-a');
      expect(affinity.revision).toBe(1);

      const observed = store.findAffinity({ source: 'body-session', id: 'session-1' }, 'model-a', ENDED_AT);
      expect(observed).toEqual({ providerId: 'provider-a', revision: 1, active: true });
    } finally {
      handle.close();
    }
  });
});
