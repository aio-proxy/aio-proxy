import { describe, expect, test } from 'bun:test';

import { DashboardRequestLogsResponseSchema } from '@aio-proxy/types';

import { createTraceStore } from '../index';
import { openTestDb } from '../test-support';
import type { StoredSpan, TraceCompletion, TraceRootStart } from '../types';

const NOW = new Date('2026-07-11T08:00:00.000Z');
const PAGE_SIZE = 20 as const;

function rootStart(traceId: string, startedAt: Date, attrs: Record<string, unknown>): TraceRootStart {
  return {
    traceId,
    spanId: `${traceId}-root`,
    requestId: `req-${traceId}`,
    inboundProtocol: 'openai-compatible',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt,
    statusCode: 0,
    attributes: {
      'aio_proxy.protocol.inbound': 'openai-compatible',
      'aio_proxy.request.id': `req-${traceId}`,
      ...attrs,
    },
    events: [],
    links: [],
  };
}

function rootSpan(traceId: string, startedAt: Date, endedAt: Date, attrs: Record<string, unknown>): StoredSpan {
  return {
    traceId,
    spanId: `${traceId}-root`,
    name: 'aio_proxy.request',
    kind: 1,
    startedAt,
    endedAt,
    statusCode: 0,
    attributes: {
      'aio_proxy.protocol.inbound': 'openai-compatible',
      'aio_proxy.request.id': `req-${traceId}`,
      ...attrs,
    },
    events: [],
    links: [],
  };
}

function attemptSpan(
  traceId: string,
  index: number,
  startedAt: Date,
  endedAt: Date,
  attrs: Record<string, unknown>,
): StoredSpan {
  return {
    traceId,
    spanId: `${traceId}-attempt-${index}`,
    parentSpanId: `${traceId}-root`,
    name: 'aio_proxy.provider.attempt',
    kind: 3,
    startedAt,
    endedAt,
    statusCode: 0,
    attributes: { 'aio_proxy.attempt.index': index, ...attrs },
    events: [],
    links: [],
  };
}

function completeWithAttempts(
  store: ReturnType<typeof createTraceStore>,
  traceId: string,
  startedAt: Date,
  endedAt: Date,
  summary: TraceCompletion['summary'],
  rootAttrs: Record<string, unknown>,
  attempts: readonly StoredSpan[],
) {
  store.startRoot(rootStart(traceId, startedAt, rootAttrs));
  store.complete({
    traceId,
    rootSpanId: `${traceId}-root`,
    spans: [rootSpan(traceId, startedAt, endedAt, rootAttrs), ...attempts],
    summary,
  });
}

describe('legacy request-logs projection from trace roots', () => {
  test('projects a completed root and its attempt children into DashboardRequestLog', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      const started = new Date(NOW.getTime());
      const failedEnd = new Date(NOW.getTime() + 50);
      const successEnd = new Date(NOW.getTime() + 200);
      completeWithAttempts(
        store,
        'trace-a',
        started,
        successEnd,
        {
          finalProviderId: 'openai',
          finalModelId: 'gpt-4o',
          finalHttpStatus: 200,
          usage: {
            providerId: 'openai',
            modelId: 'gpt-4o',
            inputTokens: 10,
            outputTokens: 5,
            estimatedCostUsd: 0.1,
          },
        },
        { 'gen_ai.request.model': 'gpt-4o-alias' },
        [
          attemptSpan('trace-a', 0, started, failedEnd, {
            'aio_proxy.provider.id': 'anthropic',
            'aio_proxy.provider.kind': 'api',
            'aio_proxy.protocol.target': 'anthropic-messages',
            'gen_ai.response.model': 'claude',
            'aio_proxy.termination.reason': 'failure',
            'aio_proxy.error.code': 'upstream_error',
            'http.status_code': 500,
          }),
          attemptSpan('trace-a', 1, failedEnd, successEnd, {
            'aio_proxy.provider.id': 'openai',
            'aio_proxy.provider.kind': 'api',
            'aio_proxy.protocol.target': 'openai-response',
            'gen_ai.response.model': 'gpt-4o',
            'http.status_code': 200,
          }),
        ],
      );

      const result = store.listRequestLogs({ page: 1, pageSize: PAGE_SIZE });
      expect(result.total).toBe(1);
      const [log] = result.items;
      expect(log.requestId).toBe('req-trace-a');
      expect(log.requestedModelId).toBe('gpt-4o-alias');
      expect(log.outcome).toBe('success');
      expect(log.finalProviderId).toBe('openai');
      expect(log.finalStatusCode).toBe(200);
      expect(log.completedAt).toBe(successEnd.toISOString());
      expect(log.durationMs).toBe(200);
      expect(log.usage?.inputTokens).toBe(10);
      expect(log.usage?.outputTokens).toBe(5);
      expect(log.usage?.estimatedCostUsd).toBe(0.1);
      expect(log.attempts).toHaveLength(2);
      expect(log.attempts[0]).toMatchObject({
        index: 0,
        providerId: 'anthropic',
        protocol: 'anthropic-messages',
        outcome: 'failure',
        statusCode: 500,
        errorCode: 'upstream_error',
      });
      expect(log.attempts[1]).toMatchObject({ index: 1, providerId: 'openai', outcome: 'success', statusCode: 200 });
    } finally {
      handle.close();
    }
  });

  test('lists only completed roots and filters by outcome', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      completeWithAttempts(
        store,
        'ok',
        new Date(NOW.getTime()),
        new Date(NOW.getTime() + 100),
        { finalProviderId: 'openai', finalModelId: 'gpt-4o', finalHttpStatus: 200 },
        {},
        [],
      );
      completeWithAttempts(
        store,
        'bad',
        new Date(NOW.getTime() + 10),
        new Date(NOW.getTime() + 120),
        { finalProviderId: 'openai', finalModelId: 'gpt-4o', finalHttpStatus: 500, terminationReason: 'failure' },
        {},
        [],
      );
      // A running root (never completed) must not appear.
      store.startRoot(rootStart('running', new Date(NOW.getTime() + 20), {}));

      expect(store.listRequestLogs({ page: 1, pageSize: PAGE_SIZE }).total).toBe(2);
      const failures = store.listRequestLogs({ page: 1, pageSize: PAGE_SIZE, outcome: 'failure' });
      expect(failures.total).toBe(1);
      expect(failures.items[0]?.requestId).toBe('req-bad');
    } finally {
      handle.close();
    }
  });
});

describe('early-rejected request-log projection', () => {
  test('projects an early-rejected request with the unparsed model sentinel', () => {
    const handle = openTestDb();
    try {
      const store = createTraceStore(handle.db);
      completeWithAttempts(
        store,
        'unparsed',
        NOW,
        new Date(NOW.getTime() + 100),
        { finalHttpStatus: 400, terminationReason: 'failure' },
        {},
        [],
      );

      const result = store.listRequestLogs({ page: 1, pageSize: PAGE_SIZE });

      expect(result.items[0]?.requestedModelId).toBe('<unparsed>');
      expect(DashboardRequestLogsResponseSchema.parse(result)).toEqual(result);
    } finally {
      handle.close();
    }
  });
});
