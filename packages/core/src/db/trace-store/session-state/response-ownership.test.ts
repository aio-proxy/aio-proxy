import { describe, expect, test } from 'bun:test';

import { sessionResponse } from '../../schema';
import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';

const STARTED_AT = new Date('2026-07-24T10:00:00.000Z');

describe('response ownership', () => {
  test('refreshes the same response owner without marking it ambiguous', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      complete(store, {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        requestId: 'r1',
        responseId: 'resp-shared',
        providerId: 'provider-a',
        sessionId: 'session-1',
        endedAt: new Date('2026-07-24T10:00:00.100Z'),
      });
      const firstExpiry = handle.db.select().from(sessionResponse).get()!.expiresAt;

      const endedAt = new Date('2026-07-24T10:30:00.100Z');
      complete(store, {
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
        requestId: 'r2',
        responseId: 'resp-shared',
        providerId: 'provider-a',
        sessionId: 'session-1',
        endedAt,
      });

      const row = handle.db.select().from(sessionResponse).get()!;
      expect(row).toMatchObject({
        ambiguous: false,
        providerId: 'provider-a',
        sessionId: 'session-1',
        sessionSource: 'body-session',
      });
      expect(row.expiresAt.getTime()).toBeGreaterThan(firstExpiry.getTime());
      expect(store.resolveResponse('resp-shared', endedAt)).toEqual({
        status: 'owned',
        owner: {
          identity: { source: 'body-session', id: 'session-1' },
          providerId: 'provider-a',
        },
      });
    } finally {
      handle.close();
    }
  });

  test('marks a response id with different owners ambiguous without overwriting the first owner', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      complete(store, {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        requestId: 'r1',
        responseId: 'resp-collision',
        providerId: 'provider-a',
        sessionId: 'session-1',
        endedAt: new Date('2026-07-24T10:00:00.100Z'),
      });
      complete(store, {
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
        requestId: 'r2',
        responseId: 'resp-collision',
        providerId: 'provider-b',
        sessionId: 'session-2',
        endedAt: new Date('2026-07-24T10:00:01.100Z'),
      });

      expect(handle.db.select().from(sessionResponse).get()).toMatchObject({
        ambiguous: true,
        providerId: 'provider-a',
        sessionId: 'session-1',
        sessionSource: 'body-session',
      });
      expect(store.resolveResponse('resp-collision', new Date('2026-07-24T10:00:02.100Z'))).toEqual({
        status: 'ambiguous',
      });
    } finally {
      handle.close();
    }
  });

  test('keeps an ambiguous response id fail-closed after its ownership TTL expires', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      complete(store, {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        requestId: 'r1',
        responseId: 'resp-expired-collision',
        providerId: 'provider-a',
        sessionId: 'session-1',
        endedAt: new Date('2026-07-24T10:00:00.100Z'),
      });
      complete(store, {
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
        requestId: 'r2',
        responseId: 'resp-expired-collision',
        providerId: 'provider-b',
        sessionId: 'session-2',
        endedAt: new Date('2026-07-24T10:00:01.100Z'),
      });

      expect(store.resolveResponse('resp-expired-collision', new Date('2026-07-24T12:00:00.000Z'))).toEqual({
        status: 'ambiguous',
      });
    } finally {
      handle.close();
    }
  });

  test('does not prune ambiguous response ownership tombstones', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      complete(store, {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        requestId: 'r1',
        responseId: 'resp-pruned-collision',
        providerId: 'provider-a',
        sessionId: 'session-1',
        endedAt: new Date('2026-07-24T10:00:00.100Z'),
      });
      complete(store, {
        traceId: 'c'.repeat(32),
        spanId: 'd'.repeat(16),
        requestId: 'r2',
        responseId: 'resp-pruned-collision',
        providerId: 'provider-b',
        sessionId: 'session-2',
        endedAt: new Date('2026-07-24T10:00:01.100Z'),
      });

      const future = new Date('2026-07-24T12:00:00.000Z');
      store.prune(future, future);

      expect(handle.db.select().from(sessionResponse).get()).toMatchObject({ ambiguous: true });
      expect(store.resolveResponse('resp-pruned-collision', future)).toEqual({ status: 'ambiguous' });
    } finally {
      handle.close();
    }
  });
});

function complete(
  store: ReturnType<typeof createTraceStore>,
  input: {
    readonly traceId: string;
    readonly spanId: string;
    readonly requestId: string;
    readonly responseId: string;
    readonly providerId: string;
    readonly sessionId: string;
    readonly endedAt: Date;
  },
): void {
  store.startRoot({
    traceId: input.traceId,
    spanId: input.spanId,
    requestId: input.requestId,
    inboundProtocol: 'openai-response',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: STARTED_AT,
    statusCode: 0,
    attributes: {},
    events: [],
    links: [],
  });
  store.complete({
    traceId: input.traceId,
    rootSpanId: input.spanId,
    spans: [
      {
        traceId: input.traceId,
        spanId: input.spanId,
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: STARTED_AT,
        endedAt: input.endedAt,
        statusCode: 0,
        attributes: {},
        events: [],
        links: [],
      },
    ],
    summary: { finalProviderId: input.providerId, finalModelId: 'model-a', finalHttpStatus: 200 },
    session: {
      identity: { source: 'body-session', id: input.sessionId },
      requestedModelId: 'model-a',
      resolvedBy: 'body-session',
    },
    sessionState: { responseId: input.responseId },
  });
}
