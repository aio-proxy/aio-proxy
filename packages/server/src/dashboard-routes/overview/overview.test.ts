import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig } from '@aio-proxy/core';
import {
  DashboardOverviewActivityResponseSchema,
  DashboardOverviewDiagnosticsResponseSchema,
  DashboardOverviewResponseSchema,
} from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true });
});

async function overviewRoutes() {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-dashboard-overview-'));
  homes.push(home);
  const config = parseRuntimeConfig({
    providers: {
      first: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://first.example.test/v1',
        models: ['first-model'],
      },
      second: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://second.example.test/v1',
        models: ['second-model'],
      },
    },
  });
  const state = await createServerState({ config, dbHome: home, watchConfig: false });
  return { routes: createDashboardRoutes(state, disabledDashboardAuthentication), state };
}

describe('GET /overview', () => {
  test('returns only typed 90d range data with the configured provider count', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview?range=90d');
      const body = DashboardOverviewResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ range: '90d', summary: { providerCount: 2 } });
      expect('providerHealth' in body).toBe(false);
      expect('topModelCosts' in body).toBe(false);
      expect('activity' in body).toBe(false);
    } finally {
      state.close();
    }
  });

  test('returns range-scoped diagnostics from an independent endpoint', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview/diagnostics?range=90d');

      expect(response.status).toBe(200);
      expect(DashboardOverviewDiagnosticsResponseSchema.parse(await response.json())).toEqual({
        providerHealth: null,
        topModelCosts: [],
        topModelTokens: [],
      });
    } finally {
      state.close();
    }
  });

  test('returns rolling activity from an independent endpoint', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview/activity');
      const body = DashboardOverviewActivityResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body.items).toBeDefined();
      expect(body).not.toHaveProperty('year');
      expect(body).not.toHaveProperty('days');
    } finally {
      state.close();
    }
  });

  test('ignores unknown query params on activity endpoint', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/overview/activity?year=2026');
      const body = DashboardOverviewActivityResponseSchema.parse(await response.json());

      expect(response.status).toBe(200);
      expect(body.items).toBeDefined();
    } finally {
      state.close();
    }
  });

  test('rejects ranges outside the dashboard overview contract', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      expect((await routes.request('/overview?range=14d')).status).toBe(400);
    } finally {
      state.close();
    }
  });

  test('keeps the legacy 14d usage range valid', async () => {
    const { routes, state } = await overviewRoutes();
    try {
      const response = await routes.request('/usage?range=14d&metric=cost&groupBy=model');
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ range: '14d' });
    } finally {
      state.close();
    }
  });
});

test('real authenticated requests attribute usage before credentials are stripped and rejected keys never enter ranking', async () => {
  const { createServer } = await import('../../server/server');
  const { loopbackServer } = await import('../../dashboard-auth/test-support');
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-caller-e2e-'));
  homes.push(home);
  const upstreamHeaders: Headers[] = [];
  const upstream = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      upstreamHeaders.push(request.headers);
      return Response.json({
        id: 'chat-result',
        object: 'chat.completion',
        created: 1,
        model: 'test-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      });
    },
  });
  const app = await createServer({
    config: {
      router: { models: { 'test-model': { metadata: { cost: { input: 1, output: 2 } } } } },
      server: {
        apiKeys: [
          { key: 'alice-secret', label: 'Alice' },
          { key: 'bob-secret', label: 'Bob' },
        ],
      },
      providers: {
        test: {
          kind: 'api',
          protocol: 'openai-compatible',
          baseURL: `http://127.0.0.1:${upstream.port}/v1`,
          models: ['test-model'],
        },
      },
    },
    dbHome: home,
    watchConfig: false,
    logger: () => {},
  });
  try {
    for (const key of ['alice-secret', 'bob-secret', 'alice-secret']) {
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hello' }] }),
      });
      if (response.status !== 200)
        throw new Error(`Unexpected request status ${response.status}: ${await response.text()}`);
      expect(response.status).toBe(200);
      await response.text();
    }
    const rejected = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
      body: '{}',
    });
    expect(rejected.status).toBe(401);
    const get = async (path: string) => (await app.request(path, {}, loopbackServer)).json();
    let ranking: Array<{ id: string; label: string; requestCount: string; totalTokens: string }> = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      ranking = await get('/dashboard/api/overview/caller-ranking?range=24h');
      if (ranking.reduce((count, caller) => count + Number(caller.requestCount), 0) === 3) break;
      await Bun.sleep(5);
    }
    const alice = ranking.find((caller) => caller.label === 'Alice')!;
    expect(alice).toMatchObject({ requestCount: '2', totalTokens: '30', estimatedCostNanoUsd: '40000' });
    expect(ranking.find((caller) => caller.label === 'Bob')).toMatchObject({ requestCount: '1', totalTokens: '15' });
    const filtered = await get(`/dashboard/api/overview?range=24h&callerId=${alice.id}`);
    expect(filtered.summary.current).toMatchObject({ requestCount: '2', totalTokens: '30' });
    const traces = await get(`/dashboard/api/traces?callerId=${alice.id}`);
    expect(traces.items).toHaveLength(2);
    expect(traces.items.every((item: { caller: { id: string } }) => item.caller.id === alice.id)).toBe(true);
    const detail = await get(`/dashboard/api/traces/${traces.items[0].traceId}`);
    expect(detail.trace.caller).toMatchObject({ id: alice.id, label: 'Alice' });
    expect(JSON.stringify({ ranking, traces, detail })).not.toMatch(/alice-secret|bob-secret/u);
    expect(upstreamHeaders).toHaveLength(3);
    expect(upstreamHeaders.every((headers) => !headers.has('authorization') && !headers.has('x-api-key'))).toBe(true);
  } finally {
    app.close();
    await upstream.stop(true);
  }
});
