import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTraceStore, openDb } from '@aio-proxy/core/db';
import { DashboardTraceDetailSchema, DashboardTracesResponseSchema } from '@aio-proxy/types';

import { loopbackServer } from '../../dashboard-auth/test-support';
import { createServer } from '../../index';

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const ATTEMPT_SPAN_ID = 'c'.repeat(16);
const INFERENCE_SPAN_ID = 'd'.repeat(16);
const RUNNING_TRACE_ID = 'e'.repeat(32);
const RUNNING_ROOT_SPAN_ID = 'f'.repeat(16);
const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

async function seededApp() {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-traces-'));
  homes.push(home);
  const app = await createServer({ config: { providers: {} }, dbHome: home });
  const handle = openDb({ home });
  const store = createTraceStore(handle.db);
  const startedAt = new Date('2026-07-27T08:00:00.000Z');
  const endedAt = new Date('2026-07-27T08:00:00.100Z');
  const rootAttributes = {
    'aio_proxy.protocol.inbound': 'openai-response',
    'aio_proxy.request.id': 'request-a',
    'aio_proxy.session.id': 'session-a',
    'aio_proxy.session.resolved_by': 'header-session',
    'aio_proxy.session.source': 'header-session',
    'gen_ai.request.model': 'gpt-5',
  };
  store.startRoot({
    traceId: TRACE_ID,
    spanId: ROOT_SPAN_ID,
    requestId: 'request-a',
    inboundProtocol: 'openai-response',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt,
    statusCode: 0,
    attributes: rootAttributes,
    events: [],
    links: [],
  });
  store.complete({
    traceId: TRACE_ID,
    rootSpanId: ROOT_SPAN_ID,
    spans: [
      {
        traceId: TRACE_ID,
        spanId: ROOT_SPAN_ID,
        name: 'aio_proxy.request',
        kind: 1,
        startedAt,
        endedAt,
        statusCode: 1,
        attributes: rootAttributes,
        events: [],
        links: [],
      },
      {
        traceId: TRACE_ID,
        spanId: ATTEMPT_SPAN_ID,
        parentSpanId: ROOT_SPAN_ID,
        name: 'aio_proxy.provider.attempt',
        kind: 2,
        startedAt: new Date(startedAt.getTime() + 10),
        endedAt: new Date(endedAt.getTime() - 10),
        statusCode: 1,
        attributes: { 'aio_proxy.provider.id': 'provider-a' },
        events: [],
        links: [],
      },
      {
        traceId: TRACE_ID,
        spanId: INFERENCE_SPAN_ID,
        parentSpanId: ATTEMPT_SPAN_ID,
        name: 'gen_ai.inference',
        kind: 2,
        startedAt: new Date(startedAt.getTime() + 20),
        endedAt: new Date(endedAt.getTime() - 20),
        statusCode: 1,
        attributes: { 'gen_ai.response.model': 'gpt-5' },
        events: [],
        links: [],
      },
    ],
    summary: {
      finalProviderId: 'provider-a',
      finalModelId: 'gpt-5',
      finalHttpStatus: 200,
    },
    session: {
      identity: { source: 'header-session', id: 'session-a' },
      requestedModelId: 'gpt-5',
      resolvedBy: 'header-session',
    },
  });
  store.startRoot({
    traceId: RUNNING_TRACE_ID,
    spanId: RUNNING_ROOT_SPAN_ID,
    requestId: 'request-b',
    inboundProtocol: 'openai-response',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: new Date('2026-07-27T08:01:00.000Z'),
    statusCode: 0,
    attributes: {
      'aio_proxy.protocol.inbound': 'openai-response',
      'aio_proxy.request.id': 'request-b',
      'aio_proxy.session.id': 'session-b',
      'aio_proxy.session.resolved_by': 'header-session',
      'aio_proxy.session.source': 'header-session',
      'gen_ai.request.model': 'gpt-5',
    },
    events: [],
    links: [],
  });
  handle.close();
  return app;
}

describe('Dashboard trace routes', () => {
  test('lists filtered traces and returns ordered trace detail', async () => {
    const app = await seededApp();
    const list = await app.request(
      '/dashboard/api/traces?page=1&pageSize=10&sessionSource=header-session&sessionId=session-a',
      undefined,
      loopbackServer,
    );
    const listBody = DashboardTracesResponseSchema.parse(await list.json());

    expect(list.status).toBe(200);
    expect(listBody).toMatchObject({
      total: 1,
      items: [{ traceId: TRACE_ID, session: { source: 'header-session', id: 'session-a' } }],
    });

    const unfiltered = await app.request('/dashboard/api/traces?pageSize=10', undefined, loopbackServer);
    const unfilteredBody = DashboardTracesResponseSchema.parse(await unfiltered.json());
    expect(unfilteredBody.total).toBe(2);
    expect(unfilteredBody.items[0]).toMatchObject({ traceId: RUNNING_TRACE_ID, endedAt: null });

    const detail = await app.request(`/dashboard/api/traces/${TRACE_ID}`, undefined, loopbackServer);
    const detailBody = DashboardTraceDetailSchema.parse(await detail.json());

    expect(detail.status).toBe(200);
    expect(detail.headers.get('cache-control')).toBe('no-store');
    expect(detailBody.spans.map((span) => span.spanId)).toEqual([ROOT_SPAN_ID, ATTEMPT_SPAN_ID, INFERENCE_SPAN_ID]);
  });

  test('returns 404 for a valid missing trace id', async () => {
    const response = await (
      await seededApp()
    ).request(`/dashboard/api/traces/${'0'.repeat(32)}`, undefined, loopbackServer);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'trace not found' });
  });

  test.each([
    '?page=0',
    '?page=1.5',
    '?pageSize=25',
    '?startedAfter=not-a-date',
    '?startedBefore=not-a-date',
    '?traceId=bad',
    `?traceId=${'A'.repeat(32)}`,
    '?otelStatusCode=BAD',
    '?terminationReason=success',
    '?finalHttpStatus=abc',
    '?finalHttpStatus=99',
    '?finalHttpStatus=600',
    '/bad',
    `/${'A'.repeat(32)}`,
  ])('rejects invalid trace input %s', async (suffix) => {
    const response = await (await seededApp()).request(`/dashboard/api/traces${suffix}`, undefined, loopbackServer);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed', details: expect.any(Array) });
  });
});
