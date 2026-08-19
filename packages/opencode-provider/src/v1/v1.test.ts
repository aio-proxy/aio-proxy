import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentRuntimeError, readLastKnownCatalog, refreshAgentCatalog } from '@aio-proxy/agent-provider-runtime';
import type { AgentCatalogV1, AgentDeviceCodeResponse, AgentManagedMarker, AgentTokenResponse } from '@aio-proxy/types';
import type { Config, Hooks, PluginInput } from '@opencode-ai/plugin';

import { createOpenCodeV1Server, type OpenCodeV1Deps } from './v1';

type AuthLoader = NonNullable<NonNullable<Hooks['auth']>['loader']>;
type GetAuth = Parameters<AuthLoader>[0];
type Auth = Awaited<ReturnType<GetAuth>>;
type Provider = Parameters<AuthLoader>[1];

test('authorize presents Device Code and returns OpenCode OAuth credentials', async () => {
  const f = await fixture();
  f.device.resolve({
    device_code: 'device',
    user_code: 'ABCD-EFGH',
    verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    expires_in: 600,
    interval: 5,
  });
  f.poll.resolve({
    token_type: 'Bearer',
    access_token: 'aio_agent_at_v1_access',
    refresh_token: 'aio_agent_rt_v1_refresh',
    expires_in: 900,
  });
  f.catalogResponses.push(catalog({ name: 'After Login' }));
  const hooks = await f.server();
  const flow = await hooks.auth!.methods[0]!.authorize();
  expect(flow).toMatchObject({ method: 'auto', url: expect.stringContaining('#code=ABCD-EFGH') });
  expect(await flow.callback()).toEqual({
    type: 'success',
    provider: 'aio-proxy',
    access: 'aio_agent_at_v1_access',
    refresh: 'aio_agent_rt_v1_refresh',
    expires: f.now + 900_000,
  });
  expect(f.readState().lkg.models[0].name).toBe('After Login');
  expect(f.authSet).not.toHaveBeenCalled();
  expect(f.instanceDispose).not.toHaveBeenCalled();
});

test('fetch re-reads expired auth, persists one rotation, and replaces caller authorization', async () => {
  const f = await fixture({ auth: { type: 'oauth', access: 'old', refresh: 'aio_agent_rt_v1_old', expires: 999 } });
  f.setNow(1_000);
  f.refresh.resolve({
    token_type: 'Bearer',
    access_token: 'aio_agent_at_v1_new',
    refresh_token: 'aio_agent_rt_v1_new',
    expires_in: 900,
  });
  const loader = (await f.server()).auth!.loader!;
  const options = await loader(f.getAuth, f.provider);
  await Promise.all([
    options.fetch('http://127.0.0.1:9317/v1/chat/completions', { headers: { authorization: 'Bearer caller' } }),
    options.fetch('http://127.0.0.1:9317/v1/chat/completions'),
  ]);
  expect(f.refreshCalls).toBe(1);
  expect(f.authSet).toHaveBeenCalledTimes(1);
  expect(f.upstreamHeaders).toEqual(['Bearer aio_agent_at_v1_new', 'Bearer aio_agent_at_v1_new']);
});

test('401 never falls back to an anonymous retry', async () => {
  const f = await fixture({ upstreamStatus: 401 });
  f.refresh.resolve({
    token_type: 'Bearer',
    access_token: 'aio_agent_at_v1_new',
    refresh_token: 'aio_agent_rt_v1_new',
    expires_in: 900,
  });
  const options = await (await f.server()).auth!.loader!(f.getAuth, f.provider);
  const request = new Request('http://127.0.0.1:9317/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"messages":[]}',
  });
  await options.fetch(request);
  expect(f.upstreamHeaders).toHaveLength(2);
  expect(f.upstreamBodies).toEqual(['{"messages":[]}', '{"messages":[]}']);
  expect(f.upstreamHeaders.every((value) => value?.startsWith('Bearer aio_agent_at_v1_'))).toBe(true);
  expect(f.refreshCalls).toBe(1);
  expect(f.anonymousCalls).toBe(0);
});

test('two catalog 401 responses preserve LKG and require login after one rotation', async () => {
  const f = await fixture({ lkg: catalog() });
  f.catalogResponses.push(401, 401);
  f.refresh.resolve({
    token_type: 'Bearer',
    access_token: 'aio_agent_at_v1_new',
    refresh_token: 'aio_agent_rt_v1_new',
    expires_in: 900,
  });
  await expect((await f.server()).auth!.loader!(f.getAuth, f.provider)).rejects.toThrow('aio-proxy login required');
  expect(f.refreshCalls).toBe(1);
  expect(f.catalogRefreshCalls).toBe(2);
  expect(f.readState()).toMatchObject({ status: 'stale', lastError: 'unauthorized' });
  expect(f.anonymousCalls).toBe(0);
});

test('catalog 401 plus refresh invalid_grant preserves LKG and requires login', async () => {
  const f = await fixture({ lkg: catalog() });
  f.catalogResponses.push(401);
  f.refresh.reject(new AgentRuntimeError('invalid_grant'));
  await expect((await f.server()).auth!.loader!(f.getAuth, f.provider)).rejects.toThrow('aio-proxy login required');
  expect(f.refreshCalls).toBe(1);
  expect(f.readState()).toMatchObject({ status: 'stale', lastError: 'unauthorized' });
  expect(f.anonymousCalls).toBe(0);
});

test('config injects a zero-model provider before the first successful catalog', async () => {
  const f = await fixture({ lkg: null });
  const config = { provider: {} } as Config;
  await (
    await f.server()
  ).config!(config);
  expect(config.provider?.['aio-proxy']).toEqual({
    name: 'aio-proxy',
    npm: '@ai-sdk/openai-compatible',
    options: { apiKey: 'aio-proxy-managed', baseURL: 'http://127.0.0.1:9317/v1' },
    models: {},
  });
});

test('concurrent loaders share one catalog refresh and one interval, then dispose clears it', async () => {
  const f = await fixture();
  const hooks = await f.server();
  await Promise.all([hooks.auth!.loader!(f.getAuth, f.provider), hooks.auth!.loader!(f.getAuth, f.provider)]);
  expect(f.catalogRefreshCalls).toBe(1);
  expect(f.activeIntervals()).toBe(1);
  await hooks.dispose!();
  expect(f.activeIntervals()).toBe(0);
});

test('new catalog content persists before one rebuild and identical content terminates', async () => {
  const f = await fixture({ lkg: catalog({ name: 'Old' }) });
  f.catalogResponses.push(catalog({ name: 'New' }), catalog({ name: 'New' }));
  const hooks = await f.server();
  await hooks.auth!.loader!(f.getAuth, f.provider);
  expect(f.readState().lkg.models[0].name).toBe('New');
  expect(f.instanceDispose).toHaveBeenCalledTimes(1);
  await f.runRefreshTimer();
  expect(f.instanceDispose).toHaveBeenCalledTimes(1);
});

test('stale refresh preserves LKG without rebuilding for status-only changes', async () => {
  const old = catalog({ name: 'Old' });
  const f = await fixture({ lkg: old });
  const hooks = await f.server();
  await hooks.auth!.loader!(f.getAuth, f.provider);
  expect(f.readState()).toMatchObject({ status: 'stale', lkg: old });
  expect(f.instanceDispose).not.toHaveBeenCalled();
});

type FixtureOptions = {
  readonly auth?: Auth;
  readonly lkg?: AgentCatalogV1 | null;
  readonly upstreamStatus?: number;
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const deferred = <T>() => Promise.withResolvers<T>();
const catalog = (overrides: Partial<AgentCatalogV1['models'][number]> = {}): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'opencode',
  models: [
    {
      id: 'gpt-x',
      name: 'GPT X',
      reasoning: true,
      tool_call: true,
      temperature: false,
      attachment: false,
      input: ['text'],
      context_window: 8_192,
      max_output_tokens: 2_048,
      ...overrides,
    },
  ],
});

async function fixture(options: FixtureOptions = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), 'aio-proxy-opencode-unit-'));
  roots.push(rootDir);
  const statePath = join(rootDir, '.aio-proxy-state.json');
  const marker = {
    format: 1,
    managedBy: 'aio-proxy',
    agent: 'opencode',
    installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
    adapterVersion: '1.2.3',
    endpoint: 'http://127.0.0.1:9317',
  } as const satisfies AgentManagedMarker;
  await Bun.write(join(rootDir, '.aio-proxy-managed.json'), JSON.stringify(marker));
  if (options.lkg !== undefined)
    await Bun.write(
      statePath,
      JSON.stringify({
        format: 1,
        catalogSchema: 1,
        status: options.lkg === null ? 'missing' : 'fresh',
        lastSuccessfulAt: options.lkg === null ? null : '2026-08-18T00:00:00.000Z',
        lastError: null,
        lkg: options.lkg,
      }),
    );

  let now = 1_000;
  let storedAuth: Auth = options.auth ?? {
    type: 'oauth',
    access: 'aio_agent_at_v1_access',
    refresh: 'aio_agent_rt_v1_refresh',
    expires: 901_000,
  };
  const device = deferred<AgentDeviceCodeResponse>();
  const poll = deferred<AgentTokenResponse>();
  const refresh = deferred<AgentTokenResponse>();
  // Keep a listener attached so reject-before-await is not an unhandled rejection.
  void refresh.promise.catch(() => undefined);
  let refreshCalls = 0;
  const catalogResponses: Array<AgentCatalogV1 | number> = [];
  const upstreamHeaders: Array<string | null> = [];
  const upstreamBodies: string[] = [];
  let anonymousCalls = 0;
  let catalogRefreshCalls = 0;
  const intervals = new Map<number, () => void | Promise<void>>();
  let intervalSequence = 0;

  const authSet = mock(async ({ body }: { readonly body: Auth }) => {
    storedAuth = body;
  });
  const instanceDispose = mock(async () => {});
  const input = {
    client: { auth: { set: authSet }, instance: { dispose: instanceDispose } },
  } as unknown as PluginInput;
  const runtimeFetch: typeof fetch = async (request, init) => {
    const normalized = new Request(request, init);
    const url = new URL(normalized.url);
    const authorization = normalized.headers.get('authorization');
    if (authorization === null) anonymousCalls += 1;
    if (url.pathname === '/v1/models') {
      const next = catalogResponses.shift();
      return next === undefined
        ? new Response('', { status: 503 })
        : typeof next === 'number'
          ? new Response('', { status: next })
          : Response.json(next);
    }
    upstreamHeaders.push(authorization);
    upstreamBodies.push(await normalized.text());
    return new Response('', { status: options.upstreamStatus ?? 200 });
  };
  const deps: OpenCodeV1Deps = {
    now: () => now,
    fetch: runtimeFetch,
    readManagedInstallation: async () => ({
      rootDir,
      markerPath: join(rootDir, '.aio-proxy-managed.json'),
      statePath,
      marker,
    }),
    readLastKnownCatalog,
    requestDeviceAuthorization: async () => device.promise,
    pollDeviceAuthorization: async () => poll.promise,
    refreshAgentCredential: async () => {
      refreshCalls += 1;
      return refresh.promise;
    },
    refreshAgentCatalog: (value) => {
      catalogRefreshCalls += 1;
      return refreshAgentCatalog({ ...value, fetch: runtimeFetch, now: () => now });
    },
    setInterval: (callback) => {
      const id = ++intervalSequence;
      intervals.set(id, callback);
      return id as ReturnType<typeof globalThis.setInterval>;
    },
    clearInterval: (id) => {
      intervals.delete(id as number);
    },
  };
  return {
    authSet,
    catalogResponses,
    device,
    instanceDispose,
    poll,
    refresh,
    upstreamBodies,
    upstreamHeaders,
    get anonymousCalls() {
      return anonymousCalls;
    },
    get now() {
      return now;
    },
    get catalogRefreshCalls() {
      return catalogRefreshCalls;
    },
    get refreshCalls() {
      return refreshCalls;
    },
    getAuth: async () => structuredClone(storedAuth),
    provider: { id: 'aio-proxy' } as Provider,
    server: () => createOpenCodeV1Server(input, deps),
    setNow: (value: number) => {
      now = value;
    },
    activeIntervals: () => intervals.size,
    runRefreshTimer: async () => {
      for (const callback of intervals.values()) await callback();
    },
    readState: () => JSON.parse(readFileSync(statePath, 'utf8')),
  };
}
