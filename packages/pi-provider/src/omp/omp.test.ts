import { expect, mock, test } from 'bun:test';

import type { AgentCatalogV1, AgentManagedMarker } from '@aio-proxy/types';
import type { ExtensionAPI, ProviderConfig } from '@oh-my-pi/pi-coding-agent';

import { toPiFamilyModels, type PiFamilyCatalogResult } from '../core';
import { registerOmp, type OmpDeps } from './omp';

test('OMP login presents verification_uri_complete through onAuth', async () => {
  const f = await fixture();
  const onAuth = mock(() => {});
  await f.provider.oauth!.login({ onAuth, onPrompt: async () => '' });
  expect(onAuth).toHaveBeenCalledWith({
    url: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
    instructions: 'Approve aio-proxy with code ABCD-EFGH',
  });
});

test('catalog 401 force-refreshes host auth once and retries only with the returned key', async () => {
  const f = await fixture({
    catalogResults: [
      { models: fModels(), source: 'lkg', status: 'stale', error: 'unauthorized' },
      { models: fModels('fresh'), source: 'network', status: 'fresh' },
    ],
  });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).resolves.toEqual([
    expect.objectContaining({ id: 'fresh' }),
  ]);
  expect(getApiKeyForProvider).toHaveBeenCalledWith('aio-proxy', undefined, { forceRefresh: true });
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('a second catalog 401 requires login after exactly one forced refresh', async () => {
  const f = await fixture({
    catalogResults: [
      { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
      { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
    ],
  });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });

  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('a missing refreshed OMP credential requires login without an anonymous retry', async () => {
  const f = await fixture({
    catalogResults: [{ models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' }],
  });
  const getApiKeyForProvider = mock(async () => undefined);
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });

  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old']);
});

test('a failed OMP credential refresh uses the stable login-required diagnostic', async () => {
  const f = await fixture({
    catalogResults: [{ models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' }],
  });
  const getApiKeyForProvider = mock(async () => {
    throw new Error('invalid_grant');
  });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });

  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old']);
});

test('pre-session undefined key serves LKG without network and marks pending recovery', async () => {
  const f = await fixture({
    catalogResults: [
      { models: fModels('lkg'), source: 'lkg', status: 'stale' },
      { models: fModels('fresh'), source: 'network', status: 'fresh' },
    ],
  });
  await expect(f.provider.fetchDynamicModels!(undefined)).resolves.toEqual([expect.objectContaining({ id: 'lkg' })]);
  expect(f.catalogAccesses).toEqual([undefined]);

  const order: string[] = [];
  const getApiKeyForProvider = mock(async () => {
    order.push('credential');
    return 'aio_agent_at_v1_new';
  });
  const refreshRuntimeProviders = mock(async () => {
    order.push('catalog');
    await f.provider.fetchDynamicModels!('aio_agent_at_v1_new');
  });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  });

  expect(order).toEqual(['credential', 'catalog']);
  expect(getApiKeyForProvider).toHaveBeenCalledWith('aio-proxy', undefined, { forceRefresh: true });
  expect(f.catalogAccesses).toEqual([undefined, 'aio_agent_at_v1_new']);
});

test('pre-session undefined key without LKG throws aio-proxy login required', async () => {
  const f = await fixture({
    catalogResults: [{ models: [], source: 'missing', status: 'missing' }],
  });
  await expect(f.provider.fetchDynamicModels!(undefined)).rejects.toThrow('aio-proxy login required');
  expect(f.catalogAccesses).toEqual([undefined]);
});

test('active-context undefined key force-refreshes and retries only with the host key', async () => {
  const f = await fixture({
    catalogResults: [{ models: fModels('fresh'), source: 'network', status: 'fresh' }],
  });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!(undefined)).resolves.toEqual([expect.objectContaining({ id: 'fresh' })]);
  expect(getApiKeyForProvider).toHaveBeenCalledWith('aio-proxy', undefined, { forceRefresh: true });
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_new']);
});

test('active-context undefined key that cannot refresh requires login without a catalog token', async () => {
  const f = await fixture();
  const getApiKeyForProvider = mock(async () => undefined);
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!(undefined)).rejects.toThrow('aio-proxy login required');
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual([]);
});

test('pre-session 401 serves LKG, then refreshes auth before the online republish', async () => {
  const f = await fixture({
    catalogResults: [
      { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
      { models: fModels('fresh'), source: 'network', status: 'fresh' },
    ],
  });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).resolves.toEqual([
    expect.objectContaining({ id: 'lkg' }),
  ]);

  const order: string[] = [];
  const getApiKeyForProvider = mock(async () => {
    order.push('credential');
    return 'aio_agent_at_v1_new';
  });
  const refreshRuntimeProviders = mock(async () => {
    order.push('catalog');
    await f.provider.fetchDynamicModels!('aio_agent_at_v1_new');
  });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  });

  expect(order).toEqual(['credential', 'catalog']);
  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('pre-session recovery does not force-refresh twice when the republish also gets 401', async () => {
  const f = await fixture({
    catalogResults: [
      { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
      { models: fModels('lkg'), source: 'lkg', status: 'stale', error: 'unauthorized' },
    ],
  });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).resolves.toEqual([
    expect.objectContaining({ id: 'lkg' }),
  ]);

  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  const refreshRuntimeProviders = mock(async () => {
    await f.provider.fetchDynamicModels!('aio_agent_at_v1_new');
  });
  await expect(
    f.emit('session_start', {
      setInterval: f.setInterval,
      modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
    }),
  ).rejects.toThrow('aio-proxy login required');

  expect(getApiKeyForProvider).toHaveBeenCalledTimes(1);
  expect(f.catalogAccesses).toEqual(['aio_agent_at_v1_old', 'aio_agent_at_v1_new']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('uses one managed timer and refreshes only runtime providers online', async () => {
  const f = await fixture();
  const refreshRuntimeProviders = mock(async () => {});
  const context = {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider: mock(async () => 'access'), refreshRuntimeProviders },
  };
  await f.emit('session_start', context);
  await f.emit('session_start', context);
  expect(f.activeTimers()).toBe(1);
  expect(f.setInterval.mock.calls[0]?.[1]).toBe(300_000);
  await f.tick();
  expect(refreshRuntimeProviders).toHaveBeenCalledWith('online');
  expect(f.setInterval).toHaveBeenCalledTimes(1);
});

test('missing catalog after a server failure throws the start-server diagnostic', async () => {
  const f = await fixture({
    catalogResults: [
      {
        models: [],
        source: 'missing',
        status: 'missing',
        error: 'server_error',
      },
    ],
  });
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders: mock(async () => {}) },
  });
  await expect(f.provider.fetchDynamicModels!('aio_agent_at_v1_old')).rejects.toThrow('aio-proxy server required');
});

test('overlapping catalog fetches coalesce only equivalent API keys', async () => {
  const f = await fixture({
    holdCatalog: true,
    catalogResults: [
      { models: fModels('same-key'), source: 'network', status: 'fresh' },
      { models: fModels('other-key'), source: 'network', status: 'fresh' },
    ],
  });
  const first = f.provider.fetchDynamicModels!('same-key');
  await f.catalogStarted;
  const second = f.provider.fetchDynamicModels!('same-key');
  const third = f.provider.fetchDynamicModels!('other-key');
  await Promise.resolve();
  await Promise.resolve();
  try {
    expect(f.catalogAccesses).toEqual(['same-key', 'other-key']);
  } finally {
    f.releaseCatalog();
  }
  const [firstModels, secondModels, thirdModels] = await Promise.all([first, second, third]);
  expect(firstModels.map(({ id }) => id)).toEqual(['same-key']);
  expect(secondModels.map(({ id }) => id)).toEqual(['same-key']);
  expect(thirdModels.map(({ id }) => id)).toEqual(['other-key']);
});

test('shutdown during session_start refresh installs no timer; later start ticks the current registry', async () => {
  const f = await fixture();
  let releaseFirst!: () => void;
  let notifyFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    notifyFirst = resolve;
  });
  const firstHold = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRefresh = mock(async () => {
    notifyFirst();
    await firstHold;
  });
  const firstContext = {
    setInterval: f.setInterval,
    modelRegistry: {
      getApiKeyForProvider: mock(async () => 'access'),
      refreshRuntimeProviders: firstRefresh,
    },
  };
  const starting = f.emit('session_start', firstContext);
  await firstStarted;
  expect(f.activeTimers()).toBe(0);
  await f.emit('session_shutdown', firstContext);
  releaseFirst();
  await starting;
  expect(f.activeTimers()).toBe(0);

  const staleRefresh = mock(async () => {});
  const currentRefresh = mock(async () => {});
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider: mock(async () => 'access'), refreshRuntimeProviders: staleRefresh },
  });
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider: mock(async () => 'access'), refreshRuntimeProviders: currentRefresh },
  });
  expect(f.activeTimers()).toBe(1);
  expect(f.setInterval.mock.calls[0]?.[1]).toBe(300_000);
  staleRefresh.mockClear();
  currentRefresh.mockClear();
  await f.tick();
  expect(staleRefresh).not.toHaveBeenCalled();
  expect(currentRefresh).toHaveBeenCalledWith('online');
  expect(f.setInterval).toHaveBeenCalledTimes(1);
});

test('pre-session catalog continuation does not mark pending recovery after a newer session starts', async () => {
  const f = await fixture({
    holdCatalog: true,
    catalogResults: [
      { models: fModels('lkg'), source: 'lkg', status: 'stale' },
      { models: fModels('fresh'), source: 'network', status: 'fresh' },
    ],
  });
  const preSession = f.provider.fetchDynamicModels!(undefined);
  await f.catalogStarted;
  const getApiKeyForProvider = mock(async () => 'aio_agent_at_v1_new');
  const refreshRuntimeProviders = mock(async () => {});
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  });
  f.releaseCatalog();
  await expect(preSession).resolves.toEqual([expect.objectContaining({ id: 'lkg' })]);

  getApiKeyForProvider.mockClear();
  refreshRuntimeProviders.mockClear();
  await f.emit('session_start', {
    setInterval: f.setInterval,
    modelRegistry: { getApiKeyForProvider, refreshRuntimeProviders },
  });
  expect(getApiKeyForProvider).not.toHaveBeenCalled();
  expect(refreshRuntimeProviders).toHaveBeenCalledWith('online');
});

const OMP_MARKER = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'omp',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;

const ompCatalog = (id = 'compat-model'): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'omp',
  models: [
    {
      id,
      name: id,
      reasoning: false,
      tool_call: true,
      temperature: false,
      attachment: false,
      input: ['text'],
      context_window: 8_192,
      max_output_tokens: 2_048,
    },
  ],
});
const fModels = (id = 'compat-model') => toPiFamilyModels(ompCatalog(id));

async function fixture(
  options: { readonly catalogResults?: PiFamilyCatalogResult[]; readonly holdCatalog?: boolean } = {},
) {
  let provider: ProviderConfig | undefined;
  const catalogAccesses: Array<string | undefined> = [];
  const results = [
    ...(options.catalogResults ?? [
      {
        models: fModels(),
        source: 'network' as const,
        status: 'fresh' as const,
      },
    ]),
  ];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const timers = new Map<number, () => void | Promise<void>>();
  let timerSequence = 0;
  const setInterval = mock((callback: () => void | Promise<void>, _delay: number) => {
    const id = ++timerSequence;
    timers.set(id, callback);
    return id as unknown as Timer;
  });
  let notifyCatalogStarted = () => {};
  const catalogStarted = new Promise<void>((resolve) => {
    notifyCatalogStarted = resolve;
  });
  let releaseCatalog = () => {};
  const catalogHold = options.holdCatalog
    ? new Promise<void>((resolve) => {
        releaseCatalog = resolve;
      })
    : undefined;
  const managed = {
    rootDir: '/managed',
    markerPath: '/managed/.aio-proxy-managed.json',
    statePath: '/managed/.aio-proxy-state.json',
    marker: OMP_MARKER,
  } as const;
  const credentials = {
    access: 'aio_agent_at_v1_access',
    refresh: 'aio_agent_rt_v1_refresh',
    expires: 901_000,
  } as const;

  const api = {
    registerProvider: (_name: string, config: ProviderConfig) => {
      provider = config;
    },
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(event, handler);
    },
  } as unknown as ExtensionAPI;
  const deps: OmpDeps = {
    readManagedInstallation: async () => managed,
    loginPiFamily: async (_managed, present) => {
      present({
        device_code: 'device',
        user_code: 'ABCD-EFGH',
        verification_uri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
        verification_uri_complete: 'http://127.0.0.1:9317/dashboard/agents/authorize#code=ABCD-EFGH',
        expires_in: 600,
        interval: 5,
      });
      return credentials;
    },
    refreshPiFamilyCredential: async () => credentials,
    readPiFamilyModels: async (_managed, access) => {
      catalogAccesses.push(access);
      notifyCatalogStarted();
      if (catalogHold !== undefined) await catalogHold;
      return results.shift() ?? { models: fModels(), source: 'network', status: 'fresh' };
    },
  };
  await registerOmp(api, deps);
  if (provider === undefined) throw new Error('OMP provider was not registered');

  return {
    provider,
    catalogAccesses,
    catalogStarted,
    releaseCatalog,
    setInterval,
    activeTimers: () => timers.size,
    tick: async () => {
      for (const callback of timers.values()) await callback();
    },
    emit: async (event: 'session_start' | 'session_shutdown', context: unknown) => {
      const handler = handlers.get(event);
      if (handler === undefined) throw new Error(`missing ${event} handler`);
      await handler({}, context);
    },
  };
}
