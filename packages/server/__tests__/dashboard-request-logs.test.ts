import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTraceStore, openDb } from '@aio-proxy/core/db';
import { createServer } from '@aio-proxy/server';
import { DashboardRequestLogsResponseSchema, ProviderKind } from '@aio-proxy/types';

import { loopbackServer } from '../src/dashboard-auth/test-support';
import { clearModelsDevCatalog, modelsDevModel, seedModelsDevCatalog } from './server.test-support';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
  clearModelsDevCatalog();
});

function rootAttributes(requestId: string, inboundProtocol: string, requestedModelId: string) {
  return {
    'aio_proxy.protocol.inbound': inboundProtocol,
    'aio_proxy.request.id': requestId,
    'gen_ai.request.model': requestedModelId,
  };
}

// Seeds the same two terminal requests the old request_log fixture used, but
// as completed trace roots (+ one attempt span) so /logs reads them from the
// traceStore projection.
function seedTraces(store: ReturnType<typeof createTraceStore>) {
  const completedAt = new Date('2026-07-12T08:00:00.000Z');
  const successStart = new Date(completedAt.getTime() - 100);
  const successAttrs = rootAttributes('request-success', 'openai-compatible', 'mini');
  store.startRoot({
    traceId: 'trace-success',
    spanId: 'trace-success-root',
    requestId: 'request-success',
    inboundProtocol: 'openai-compatible',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: successStart,
    statusCode: 0,
    attributes: successAttrs,
    events: [],
    links: [],
  });
  store.complete({
    traceId: 'trace-success',
    rootSpanId: 'trace-success-root',
    spans: [
      {
        traceId: 'trace-success',
        spanId: 'trace-success-root',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: successStart,
        endedAt: completedAt,
        statusCode: 0,
        attributes: successAttrs,
        events: [],
        links: [],
      },
      {
        traceId: 'trace-success',
        spanId: 'trace-success-attempt-0',
        parentSpanId: 'trace-success-root',
        name: 'aio_proxy.provider.attempt',
        kind: 3,
        startedAt: successStart,
        endedAt: completedAt,
        statusCode: 0,
        attributes: {
          'aio_proxy.attempt.index': 0,
          'aio_proxy.provider.id': 'openrouter',
          'aio_proxy.provider.kind': ProviderKind.Api,
          'aio_proxy.protocol.target': 'openai-compatible',
          'gen_ai.response.model': 'openai/gpt-5',
          'http.status_code': 200,
        },
        events: [],
        links: [],
      },
    ],
    summary: {
      finalProviderId: 'openrouter',
      finalModelId: 'openai/gpt-5',
      finalHttpStatus: 200,
      usage: {
        providerId: 'openrouter',
        modelId: 'openai/gpt-5',
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        estimatedCostUsd: 0.25,
      },
    },
  });

  const failureStart = new Date(completedAt.getTime() + 900);
  const failureAttrs = rootAttributes('request-failure', 'anthropic', 'sonnet');
  store.startRoot({
    traceId: 'trace-failure',
    spanId: 'trace-failure-root',
    requestId: 'request-failure',
    inboundProtocol: 'anthropic',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: failureStart,
    statusCode: 0,
    attributes: failureAttrs,
    events: [],
    links: [],
  });
  store.complete({
    traceId: 'trace-failure',
    rootSpanId: 'trace-failure-root',
    spans: [
      {
        traceId: 'trace-failure',
        spanId: 'trace-failure-root',
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: failureStart,
        endedAt: new Date(completedAt.getTime() + 1_000),
        statusCode: 0,
        attributes: failureAttrs,
        events: [],
        links: [],
      },
    ],
    summary: {
      finalProviderId: 'backup',
      finalModelId: 'claude-sonnet',
      finalHttpStatus: 503,
      terminationReason: 'failure',
      errorCode: 'upstream_unavailable',
    },
  });
}

async function seededApp() {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-logs-'));
  homes.push(home);
  // Display names now come from the models.dev catalog keyed by the id shown.
  // name !== id, so each record supplies the human-readable name directly.
  await seedModelsDevCatalog({
    mini: modelsDevModel('mini', 'GPT Mini'),
    'openai/gpt-5': modelsDevModel('openai/gpt-5', 'GPT-5'),
  });
  const app = await createServer({
    config: {
      providers: {
        openrouter: {
          kind: 'api',
          name: 'OpenRouter',
          protocol: 'openai-compatible',
          baseURL: 'https://openrouter.example.com',
          models: ['openai/gpt-5'],
        },
      },
    },
    dbHome: home,
  });
  const handle = openDb({ home });
  seedTraces(createTraceStore(handle.db));
  handle.close();
  return app;
}

describe('GET /dashboard/api/logs', () => {
  test('returns newest terminal requests with usage and attempts', async () => {
    const response = await (await seededApp()).request('/dashboard/api/logs', undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(DashboardRequestLogsResponseSchema.parse(body)).toEqual(body);
    expect(body).toMatchObject({
      page: 1,
      pageSize: 50,
      total: 2,
      pageCount: 1,
      items: [
        { requestId: 'request-failure', outcome: 'failure' },
        {
          requestId: 'request-success',
          attempts: [{ providerId: 'openrouter', statusCode: 200 }],
          usage: { totalTokens: 150, estimatedCostUsd: 0.25 },
        },
      ],
    });
  });

  test('returns current display names while preserving stored ids', async () => {
    const response = await (await seededApp()).request('/dashboard/api/logs', undefined, loopbackServer);
    const body = await response.json();

    expect(body.items).toContainEqual(
      expect.objectContaining({
        requestId: 'request-success',
        requestedModelId: 'mini',
        requestedModelDisplayName: 'GPT Mini',
        finalProviderId: 'openrouter',
        finalProviderName: 'OpenRouter',
        finalModelId: 'openai/gpt-5',
        finalModelDisplayName: 'GPT-5',
      }),
    );
  });

  test('applies combined terminal filters', async () => {
    const query = new URLSearchParams({
      page: '1',
      pageSize: '10',
      outcome: 'success',
      inboundProtocol: 'openai-compatible',
      requestedModelId: 'mini',
      finalProviderId: 'openrouter',
      finalModelId: 'openai/gpt-5',
      finalStatusCode: '200',
      startedAfter: '2026-07-12T07:59:00.000Z',
      completedBefore: '2026-07-12T08:01:00.000Z',
    });
    const response = await (await seededApp()).request(`/dashboard/api/logs?${query}`, undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.items.map((item: { requestId: string }) => item.requestId)).toEqual(['request-success']);
  });

  test.each([
    'page=0',
    'page=1.5',
    'pageSize=25',
    'finalStatusCode=abc',
    'finalStatusCode=99',
    'outcome=unknown',
    'startedAfter=not-a-date',
    'completedBefore=not-a-date',
  ])('rejects invalid query %s', async (query) => {
    const response = await (await seededApp()).request(`/dashboard/api/logs?${query}`, undefined, loopbackServer);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed', details: expect.any(Array) });
  });
});
