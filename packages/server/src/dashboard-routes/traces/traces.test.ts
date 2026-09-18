import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTraceStore, openDb } from '@aio-proxy/core/db';
import {
  DashboardTraceDetailSchema,
  DashboardTracePercentileResponseSchema,
  DashboardTracesResponseSchema,
  DashboardTraceSummaryResponseSchema,
} from '@aio-proxy/types';

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
        statusCode: 0,
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
        statusCode: 0,
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
        statusCode: 0,
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

/**
 * `count` 条已结束的同模型调用链，起点挨在一起 —— 分位窗口锚在目标自己的 `startedAt`
 * 上、前后各一小时，所以只要这批样本彼此相距够近，它们就都在对方的窗口里。
 */
async function percentileApp(count: number) {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-traces-percentile-'));
  homes.push(home);
  const app = await createServer({ config: { providers: {} }, dbHome: home });
  const handle = openDb({ home });
  const store = createTraceStore(handle.db);

  for (let index = 1; index <= count; index += 1) {
    const traceId = index.toString(16).padStart(32, '0');
    const spanId = index.toString(16).padStart(16, '0');
    const startedAt = new Date(Date.now() - 10_000);
    const endedAt = new Date(startedAt.getTime() + index * 10);
    const attributes = { 'gen_ai.response.model': 'gpt-5' };
    store.startRoot({
      traceId,
      spanId,
      requestId: `request-${index}`,
      inboundProtocol: 'openai-response',
      name: 'aio_proxy.request',
      kind: 1,
      startedAt,
      statusCode: 0,
      attributes,
      events: [],
      links: [],
    });
    store.complete({
      traceId,
      rootSpanId: spanId,
      spans: [
        {
          traceId,
          spanId,
          name: 'aio_proxy.request',
          kind: 1,
          startedAt,
          endedAt,
          statusCode: 0,
          attributes,
          events: [],
          links: [],
        },
      ],
      summary: { finalProviderId: 'provider-a', finalModelId: 'gpt-5', finalHttpStatus: 200 },
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
    '?outcome=BAD',
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

  test('summarizes traces into buckets over the requested range', async () => {
    const app = await seededApp();
    const response = await app.request(
      '/dashboard/api/traces/summary?startedAfter=2026-07-27T08:00:00.000Z&startedBefore=2026-07-27T09:00:00.000Z',
      undefined,
      loopbackServer,
    );
    const body = DashboardTraceSummaryResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.bucket).toBe('1m');
    expect(body.buckets).toHaveLength(60);
    expect(body.buckets[0]).toEqual({ at: '2026-07-27T08:00:00.000Z', success: 1, error: 0 });
    // 08:01 那条还在跑，成功和失败都不该算上它
    expect(body.buckets[1]).toEqual({ at: '2026-07-27T08:01:00.000Z', success: 0, error: 0 });
    expect(body.totals).toEqual({ success: 1, error: 0 });
  });

  // 图例 chip 点下去后，列表要跟摘要数的是同一批调用链：摘要说这个范围里 1 成功 0 失败，
  // outcome=success 就该给回那一条，outcome=error 一条都不给。
  test('filters the list by the same outcome the summary counts', async () => {
    const app = await seededApp();
    const range = 'startedAfter=2026-07-27T08:00:00.000Z&startedBefore=2026-07-27T09:00:00.000Z';
    const succeeded = await app.request(`/dashboard/api/traces?${range}&outcome=success`, undefined, loopbackServer);
    const failed = await app.request(`/dashboard/api/traces?${range}&outcome=error`, undefined, loopbackServer);

    expect(DashboardTracesResponseSchema.parse(await succeeded.json()).items.map((item) => item.traceId)).toEqual([
      TRACE_ID,
    ]);
    expect(DashboardTracesResponseSchema.parse(await failed.json()).items).toEqual([]);
  });

  test('rejects a trace summary request without a time range', async () => {
    const app = await seededApp();
    const response = await app.request('/dashboard/api/traces/summary', undefined, loopbackServer);

    expect(response.status).toBe(400);
  });

  test('compares a trace against the same-model hour once the sample clears the threshold', async () => {
    const traceId = '00000000000000000000000000000001';
    const enough = await (
      await percentileApp(30)
    ).request(`/dashboard/api/traces/${traceId}/percentile`, undefined, loopbackServer);
    const body = DashboardTracePercentileResponseSchema.parse(await enough.json());

    expect(enough.status).toBe(200);
    expect(body.comparison).toMatchObject({ modelId: 'gpt-5', sampleCount: 30, percentile: 0 });

    const sparse = await (
      await percentileApp(29)
    ).request(`/dashboard/api/traces/${traceId}/percentile`, undefined, loopbackServer);

    expect(sparse.status).toBe(200);
    expect(DashboardTracePercentileResponseSchema.parse(await sparse.json()).comparison).toBeNull();
  });

  test('returns 404 when the compared trace does not exist', async () => {
    const response = await (
      await percentileApp(30)
    ).request(`/dashboard/api/traces/${'f'.repeat(32)}/percentile`, undefined, loopbackServer);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'trace not found' });
  });
});
