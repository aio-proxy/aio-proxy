import { expect, test } from 'bun:test';

import { Hono } from 'hono';

import { createDashboardProviderReadRoutes } from '../src/dashboard-routes/provider-routes';
import type { ServerState } from '../src/server-state';

const snapshot = { items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }] };

function routesWith(quotaCache: Partial<ServerState['quotaCache']>) {
  const state = {
    quotaCache: {
      read: async () => ({ snapshot, sampledAt: 1_700_000_000_000, stale: false }),
      warm: () => {},
      ...quotaCache,
    },
    providerSummaries: async () => [],
    currentConfig: () => ({ providers: [] }),
  } as unknown as ServerState;
  return new Hono().route('/', createDashboardProviderReadRoutes(state));
}

const query = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/providers/kimi/quota', {
    method: 'QUERY',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

test('returns the cached snapshot with its sample time', async () => {
  const response = await query(routesWith({}), {});
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ snapshot, sampledAt: 1_700_000_000_000, stale: false });
});

test('forwards an explicit refresh to the cache', async () => {
  const seen: boolean[] = [];
  const app = routesWith({
    read: async (_id, _signal, refresh) => {
      seen.push(refresh === true);
      return { snapshot, sampledAt: 1, stale: false };
    },
  });
  await query(app, { refresh: true });
  await query(app, {});
  expect(seen).toEqual([true, false]);
});

test('answers a matching if-none-match with 304', async () => {
  const app = routesWith({});
  const tag = (await query(app, {})).headers.get('etag');
  expect(tag).not.toBeNull();
  const revalidated = await query(app, {}, { 'if-none-match': tag as string });
  expect(revalidated.status).toBe(304);
});

test('reports an unreadable quota as 502 rather than an empty snapshot', async () => {
  const app = routesWith({
    read: async () => {
      throw new Error('OAUTH_QUOTA_READ_FAILED');
    },
  });
  const response = await query(app, {});
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ error: 'OAUTH_QUOTA_READ_FAILED' });
});
