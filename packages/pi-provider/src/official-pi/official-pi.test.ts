import { expect, mock, test } from 'bun:test';

import type { AgentCatalogV1, AgentManagedMarker } from '@aio-proxy/types';
import type { ExtensionAPI, ProviderConfig } from '@earendil-works/pi-coding-agent';

import { toPiFamilyModels, type PiFamilyCatalogResult } from '../core';
import { registerOfficialPi, type OfficialPiDeps } from './official-pi';

test('uses onDeviceCode and returns credentials without touching auth storage', async () => {
  const f = await fixture();
  const onDeviceCode = mock(() => {});
  const credentials = await f.provider.oauth!.login({
    onDeviceCode,
    onPrompt: async () => '',
    onSelect: async () => undefined,
  });
  expect(onDeviceCode).toHaveBeenCalledWith({
    userCode: 'ABCD-EFGH',
    verificationUri: 'http://127.0.0.1:9317/dashboard/agents/authorize',
    intervalSeconds: 5,
    expiresInSeconds: 600,
  });
  expect(credentials).toMatchObject({ access: 'aio_agent_at_v1_access', refresh: 'aio_agent_rt_v1_refresh' });
});

test('refreshModels consumes host-refreshed context credential and publishes exact models', async () => {
  const f = await fixture();
  const models = await f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  expect(f.catalogAccesses).toEqual(['host-current']);
  expect(models).toEqual([expect.objectContaining({ id: 'compat-model', reasoning: false })]);
  expect(models[0]).toEqual({
    id: 'compat-model',
    name: 'compat-model',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8_192,
    maxTokens: 2_048,
  });
});

test('catalog 401 keeps host LKG and returns a stable re-login diagnostic', async () => {
  const f = await fixture({
    catalogResults: [
      {
        models: toPiFamilyModels(hostCatalog('lkg')),
        source: 'lkg',
        status: 'stale',
        error: 'unauthorized',
      },
    ],
  });
  await expect(
    f.provider.refreshModels!({
      credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }),
  ).rejects.toThrow('aio-proxy login required');
  expect(f.catalogAccesses).toEqual(['host-current']);
  expect(f.catalogAccesses).not.toContain(undefined);
});

test('offline refresh re-reads the current LKG instead of the registration snapshot', async () => {
  const f = await fixture();
  f.setLkg(hostCatalog('new-lkg'));
  const models = await f.provider.refreshModels!({
    allowNetwork: false,
    force: false,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  expect(models.map(({ id }) => id)).toEqual(['new-lkg']);
  expect(f.catalogAccesses).toEqual([]);
});

test('missing catalog after a network failure throws the start-server diagnostic', async () => {
  const f = await fixture({
    catalogResults: [
      {
        models: [],
        source: 'missing',
        status: 'missing',
        error: 'network',
      },
    ],
  });
  await expect(
    f.provider.refreshModels!({
      credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }),
  ).rejects.toThrow('aio-proxy server required');
});

test('missing incompatible schema throws the upgrade diagnostic', async () => {
  const f = await fixture({
    catalogResults: [
      {
        models: [],
        source: 'missing',
        status: 'missing',
        error: 'unsupported_schema',
      },
    ],
  });
  await expect(
    f.provider.refreshModels!({
      credential: { type: 'oauth', access: 'host-current', refresh: 'host-refresh', expires: 901_000 },
      allowNetwork: true,
      force: true,
      signal: new AbortController().signal,
      publish: async () => true,
    }),
  ).rejects.toThrow('aio-proxy adapter upgrade required');
});

test('one raw timer requests a forced provider refresh and shutdown clears it', async () => {
  const f = await fixture();
  const refresh = mock(async () => ({ aborted: false, errors: new Map() }));
  const context = { modelRegistry: { refresh } };
  await f.emit('session_start', context);
  await f.emit('session_start', context);
  expect(f.activeTimers()).toBe(1);
  expect(f.timerDelays).toEqual([300_000]);
  await f.tick();
  expect(refresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ['aio-proxy'], force: true });
  await f.emit('session_shutdown', context);
  expect(f.activeTimers()).toBe(0);
});

test('overlapping refreshModels uses each host context instead of sharing the first', async () => {
  const f = await fixture({ holdCatalog: true });
  const first = f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'old-access', refresh: 'old-refresh', expires: 1 },
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  await f.catalogStarted;
  const second = f.provider.refreshModels!({
    credential: { type: 'oauth', access: 'new-access', refresh: 'new-refresh', expires: 2 },
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    publish: async () => true,
  });
  await Promise.resolve();
  try {
    expect(f.catalogAccesses).toEqual(['old-access', 'new-access']);
  } finally {
    f.releaseCatalog();
  }
  const [firstModels, secondModels] = await Promise.all([first, second]);
  expect(firstModels.map(({ id }) => id)).toEqual(['compat-model']);
  expect(secondModels.map(({ id }) => id)).toEqual(['compat-model']);
});

test('later session_start retargets the existing timer to the new registry', async () => {
  const f = await fixture();
  const firstRefresh = mock(async () => ({ aborted: false, errors: new Map() }));
  const secondRefresh = mock(async () => ({ aborted: false, errors: new Map() }));
  await f.emit('session_start', { modelRegistry: { refresh: firstRefresh } });
  await f.emit('session_start', { modelRegistry: { refresh: secondRefresh } });
  expect(f.activeTimers()).toBe(1);
  expect(f.timerDelays).toEqual([300_000]);
  firstRefresh.mockClear();
  secondRefresh.mockClear();
  await f.tick();
  expect(firstRefresh).not.toHaveBeenCalled();
  expect(secondRefresh).toHaveBeenCalledWith({ allowNetwork: true, providers: ['aio-proxy'], force: true });
});

test('shutdown during the initial refresh prevents a later timer install', async () => {
  const f = await fixture();
  let releaseRefresh!: () => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const refresh = mock(async () => {
    notifyStarted();
    await hold;
    return { aborted: false, errors: new Map() };
  });
  const context = { modelRegistry: { refresh } };
  const starting = f.emit('session_start', context);
  await started;
  expect(f.activeTimers()).toBe(0);
  await f.emit('session_shutdown', context);
  releaseRefresh();
  await starting;
  expect(f.activeTimers()).toBe(0);
});

const HOST_MARKER = {
  format: 1,
  managedBy: 'aio-proxy',
  agent: 'pi',
  installationId: '0f4dcb50-d68c-4b99-8af1-da32480ddd09',
  adapterVersion: '1.2.3',
  endpoint: 'http://127.0.0.1:9317',
} as const satisfies AgentManagedMarker;

const hostCatalog = (id = 'compat-model'): AgentCatalogV1 => ({
  schema_version: 1,
  agent: 'pi',
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

async function fixture(
  options: { readonly catalogResults?: PiFamilyCatalogResult[]; readonly holdCatalog?: boolean } = {},
) {
  let lkg = hostCatalog();
  let provider: ProviderConfig | undefined;
  const catalogAccesses: Array<string | undefined> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const timers = new Map<number, () => void | Promise<void>>();
  const timerDelays: number[] = [];
  let timerSequence = 0;
  const catalogResults = [...(options.catalogResults ?? [])];
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
    marker: HOST_MARKER,
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
  const deps: OfficialPiDeps = {
    readManagedInstallation: async () => managed,
    readLastKnownCatalog: async () => structuredClone(lkg),
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
      return (
        catalogResults.shift() ?? {
          models: toPiFamilyModels(lkg),
          source: 'network',
          status: 'fresh',
        }
      );
    },
    setInterval: ((callback: () => void | Promise<void>, delay: number) => {
      const id = ++timerSequence;
      timerDelays.push(delay);
      timers.set(id, callback);
      return id as ReturnType<typeof globalThis.setInterval>;
    }) as OfficialPiDeps['setInterval'],
    clearInterval: ((handle: ReturnType<typeof globalThis.setInterval>) => {
      timers.delete(handle as number);
    }) as OfficialPiDeps['clearInterval'],
  };
  await registerOfficialPi(api, deps);
  if (provider === undefined) throw new Error('official Pi provider was not registered');

  return {
    provider,
    catalogAccesses,
    catalogStarted,
    releaseCatalog,
    timerDelays,
    setLkg: (next: AgentCatalogV1) => {
      lkg = next;
    },
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
