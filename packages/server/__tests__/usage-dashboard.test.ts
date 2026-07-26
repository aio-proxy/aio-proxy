import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createTraceStore, openDb } from '@aio-proxy/core/db';
import { createServer } from '@aio-proxy/server';
import { DashboardUsageOverviewResponseSchema } from '@aio-proxy/types';

import { loopbackServer } from '../src/dashboard-auth/test-support';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { force: true, recursive: true });
  }
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-usage-dashboard-'));
  homes.push(home);
  return home;
}

// Seeds three completed root traces (success+usage, failure, cancelled) so the
// dashboard /usage overview has data to aggregate. The pipeline writes traces,
// not the legacy request_log, so tests seed the trace store the route reads.
function seed(
  store: ReturnType<typeof createTraceStore>,
  spec: {
    readonly traceId: string;
    readonly startedAt: Date;
    readonly endedAt: Date;
    readonly summary: Parameters<ReturnType<typeof createTraceStore>['complete']>[0]['summary'];
  },
): void {
  const spanId = spec.traceId.slice(0, 16);
  const attrs: Record<string, unknown> = { 'aio_proxy.protocol.inbound': 'openai-compatible' };
  const { summary } = spec;
  if (summary.finalProviderId !== undefined) attrs['aio_proxy.route.final_provider_id'] = summary.finalProviderId;
  if (summary.finalModelId !== undefined) attrs['gen_ai.response.model'] = summary.finalModelId;
  if (summary.usage?.inputTokens !== undefined) attrs['gen_ai.usage.input_tokens'] = summary.usage.inputTokens;
  if (summary.usage?.outputTokens !== undefined) attrs['gen_ai.usage.output_tokens'] = summary.usage.outputTokens;
  if (summary.usage?.totalTokens !== undefined) attrs['gen_ai.usage.total_tokens'] = summary.usage.totalTokens;
  store.startRoot({
    traceId: spec.traceId,
    spanId,
    requestId: `req-${spanId}`,
    inboundProtocol: 'openai-compatible',
    name: 'aio_proxy.request',
    kind: 1,
    startedAt: spec.startedAt,
    statusCode: 0,
    attributes: attrs,
    events: [],
    links: [],
  });
  store.complete({
    traceId: spec.traceId,
    rootSpanId: spanId,
    spans: [
      {
        traceId: spec.traceId,
        spanId,
        name: 'aio_proxy.request',
        kind: 1,
        startedAt: spec.startedAt,
        endedAt: spec.endedAt,
        statusCode: summary.terminationReason === undefined ? 0 : 2,
        attributes: attrs,
        events: [],
        links: [],
      },
    ],
    summary,
  });
}

async function seededApp() {
  const home = tempHome();
  const app = await createServer({ config: { providers: {} }, dbHome: home });
  const handle = openDb({ home });
  const store = createTraceStore(handle.db);
  const completedAt = new Date();

  seed(store, {
    traceId: 'a'.repeat(32),
    startedAt: new Date(completedAt.getTime() - 100),
    endedAt: completedAt,
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
  seed(store, {
    traceId: 'b'.repeat(32),
    startedAt: new Date(completedAt.getTime() - 50),
    endedAt: completedAt,
    summary: { terminationReason: 'failure' },
  });
  seed(store, {
    traceId: 'c'.repeat(32),
    startedAt: new Date(completedAt.getTime() - 10),
    endedAt: completedAt,
    summary: { terminationReason: 'cancelled' },
  });
  handle.close();

  return app;
}

describe('GET /dashboard/api/usage', () => {
  test('returns the requested overview with pinned provider series', async () => {
    const response = await (
      await seededApp()
    ).request('/dashboard/api/usage?range=24h&metric=requests&groupBy=provider', undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(DashboardUsageOverviewResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      range: '24h',
      metric: 'requests',
      groupBy: 'provider',
      rangeStart: expect.any(String),
      rangeEnd: expect.any(String),
      bucketUnit: 'hour',
      summary: expect.objectContaining({
        requestCount: 3,
        successCount: 1,
        failureCount: 1,
        cancelledCount: 1,
        successRate: 0.5,
      }),
      series: [
        { key: 'openrouter', kind: 'dimension' },
        { key: '__failed__', kind: 'failed' },
        { key: '__cancelled__', kind: 'cancelled' },
      ],
      buckets: expect.any(Array),
    });
  });

  test('uses the default range, metric, and grouping', async () => {
    const response = await (await seededApp()).request('/dashboard/api/usage', undefined, loopbackServer);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ range: '24h', metric: 'cost', groupBy: 'model' });
  });

  test.each(['range=1h', 'metric=latency', 'groupBy=protocol'])('rejects invalid query %s', async (query) => {
    const response = await (await seededApp()).request(`/dashboard/api/usage?${query}`, undefined, loopbackServer);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: 'validation failed', details: expect.any(Array) });
  });
});
