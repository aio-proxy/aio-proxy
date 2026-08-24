import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTraceStore, openDb } from '@aio-proxy/core/db';
import { DashboardTraceDetailSchema, DashboardTracesResponseSchema } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import { loopbackServer } from '../../dashboard-auth/test-support';

const TRACE_ID = 'a'.repeat(32);
const ROOT_SPAN_ID = 'b'.repeat(16);
const ATTEMPT_SPAN_ID = 'c'.repeat(16);
const INFERENCE_SPAN_ID = 'd'.repeat(16);
const RUNNING_TRACE_ID = 'e'.repeat(32);
const RUNNING_ROOT_SPAN_ID = 'f'.repeat(16);
const LATEST_TRACE_IDS = [
  '00000000000000000000000000000015',
  '00000000000000000000000000000014',
  '00000000000000000000000000000013',
  '00000000000000000000000000000012',
  '00000000000000000000000000000011',
  '00000000000000000000000000000010',
  '0000000000000000000000000000000f',
  '0000000000000000000000000000000e',
  '0000000000000000000000000000000d',
  '0000000000000000000000000000000c',
];
const MIDDLE_TRACE_IDS = [
  '0000000000000000000000000000000b',
  '0000000000000000000000000000000a',
  '00000000000000000000000000000009',
  '00000000000000000000000000000008',
  '00000000000000000000000000000007',
  '00000000000000000000000000000006',
  '00000000000000000000000000000005',
  '00000000000000000000000000000004',
  '00000000000000000000000000000003',
  '00000000000000000000000000000002',
];
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
    'aio_proxy.diagnostics.request.protocol': 'openai-response',
    'aio_proxy.diagnostics.request.method': 'POST',
    'aio_proxy.diagnostics.request.content_type': 'application/json',
    'aio_proxy.diagnostics.request.content_length_bytes': 35,
    'aio_proxy.diagnostics.request.user_agent': 'diagnostics-test/1.0',
    'aio_proxy.diagnostics.response.status_code': 201,
    'aio_proxy.diagnostics.response.content_type': 'application/json',
    'aio_proxy.diagnostics.response.content_length_bytes': 24,
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

async function paginatedApp(traceCount = 21) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-traces-pagination-'));
  homes.push(home);
  const app = await createServer({ config: { providers: {} }, dbHome: home });
  const handle = openDb({ home });
  const store = createTraceStore(handle.db);

  for (let index = 1; index <= traceCount; index += 1) {
    const traceId = index.toString(16).padStart(32, '0');
    store.startRoot({
      traceId,
      spanId: index.toString(16).padStart(16, '0'),
      requestId: `request-${index}`,
      inboundProtocol: 'openai-response',
      name: 'aio_proxy.request',
      kind: 1,
      startedAt: new Date(`2026-07-27T08:${index.toString().padStart(2, '0')}:00.000Z`),
      statusCode: 0,
      attributes: {},
      events: [],
      links: [],
    });
  }

  handle.close();
  return app;
}

describe('Dashboard trace routes', () => {
  test('lists filtered traces and returns ordered trace detail', async () => {
    const app = await seededApp();
    const list = await app.request(
      '/dashboard/api/traces?pageSize=10&sessionSource=header-session&sessionId=session-a',
      undefined,
      loopbackServer,
    );
    const listBody = DashboardTracesResponseSchema.parse(await list.json());

    expect(list.status).toBe(200);
    expect(listBody).toEqual({
      items: [expect.objectContaining({ traceId: TRACE_ID, session: { source: 'header-session', id: 'session-a' } })],
    });

    const unfiltered = await app.request('/dashboard/api/traces?pageSize=10', undefined, loopbackServer);
    const unfilteredBody = DashboardTracesResponseSchema.parse(await unfiltered.json());
    expect(unfilteredBody.items[0]).toMatchObject({ traceId: RUNNING_TRACE_ID, endedAt: null });

    const detail = await app.request(`/dashboard/api/traces/${TRACE_ID}`, undefined, loopbackServer);
    const detailBody = DashboardTraceDetailSchema.parse(await detail.json());

    expect(detail.status).toBe(200);
    expect(detail.headers.get('cache-control')).toBe('no-store');
    expect(detailBody.spans.map((span) => span.spanId)).toEqual([ROOT_SPAN_ID, ATTEMPT_SPAN_ID, INFERENCE_SPAN_ID]);
    expect(detailBody.diagnostics).toEqual({
      request: {
        protocol: 'openai-response',
        method: 'POST',
        contentType: 'application/json',
        contentLengthBytes: 35,
        userAgent: 'diagnostics-test/1.0',
      },
      response: {
        statusCode: 201,
        contentType: 'application/json',
        contentLengthBytes: 24,
      },
    });
  });

  test('traverses trace pages in both directions with opaque tokens and omits terminal tokens', async () => {
    const app = await paginatedApp();
    const latestResponse = await app.request('/dashboard/api/traces?pageSize=10', undefined, loopbackServer);
    const latest = (await latestResponse.json()) as Record<string, unknown>;

    expect(latestResponse.status).toBe(200);
    expect(Object.keys(latest).sort()).toEqual(['items', 'nextPageToken']);
    expect((latest.items as { traceId: string }[]).map(({ traceId }) => traceId)).toEqual(LATEST_TRACE_IDS);
    expect(latest.nextPageToken).toEqual(expect.any(String));

    const middleResponse = await app.request(
      `/dashboard/api/traces?pageSize=10&pageToken=${encodeURIComponent(latest.nextPageToken as string)}`,
      undefined,
      loopbackServer,
    );
    const middle = (await middleResponse.json()) as Record<string, unknown>;

    expect(middleResponse.status).toBe(200);
    expect(Object.keys(middle).sort()).toEqual(['items', 'nextPageToken', 'prevPageToken']);
    expect((middle.items as { traceId: string }[]).map(({ traceId }) => traceId)).toEqual(MIDDLE_TRACE_IDS);
    expect(middle.nextPageToken).toEqual(expect.any(String));
    expect(middle.prevPageToken).toEqual(expect.any(String));

    const returnedLatestResponse = await app.request(
      `/dashboard/api/traces?pageSize=10&pageToken=${encodeURIComponent(middle.prevPageToken as string)}`,
      undefined,
      loopbackServer,
    );
    const returnedLatest = (await returnedLatestResponse.json()) as Record<string, unknown>;

    expect(Object.keys(returnedLatest).sort()).toEqual(['items', 'nextPageToken']);
    expect((returnedLatest.items as { traceId: string }[]).map(({ traceId }) => traceId)).toEqual(LATEST_TRACE_IDS);

    const oldestResponse = await app.request(
      `/dashboard/api/traces?pageSize=10&pageToken=${encodeURIComponent(middle.nextPageToken as string)}`,
      undefined,
      loopbackServer,
    );
    const oldest = (await oldestResponse.json()) as Record<string, unknown>;

    expect(Object.keys(oldest).sort()).toEqual(['items', 'prevPageToken']);
    expect((oldest.items as { traceId: string }[]).map(({ traceId }) => traceId)).toEqual([
      '00000000000000000000000000000001',
    ]);
  });

  test('defaults trace page size to 50', async () => {
    const response = await (await paginatedApp(51)).request('/dashboard/api/traces', undefined, loopbackServer);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['items', 'nextPageToken']);
    expect(body.items).toHaveLength(50);
    expect((body.items as { traceId: string }[])[0]?.traceId).toBe('00000000000000000000000000000033');
    expect((body.items as { traceId: string }[]).at(-1)?.traceId).toBe('00000000000000000000000000000002');
  });

  test('rejects a malformed trace page token', async () => {
    const response = await (
      await paginatedApp()
    ).request('/dashboard/api/traces?pageToken=not%2Bbase64url', undefined, loopbackServer);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed', details: expect.any(Array) });
  });

  test('returns 404 for a valid missing trace id', async () => {
    const response = await (
      await seededApp()
    ).request(`/dashboard/api/traces/${'0'.repeat(32)}`, undefined, loopbackServer);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'trace not found' });
  });

  test.each([
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
