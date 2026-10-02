import { afterEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginDiagnosticFactory, type ProviderModelCatalogRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import type { InternalServerStateOptions, ServerState, ServerStateTestHooks } from '../server-state/types';
import { listModels } from '../server/list-models';
import { isSyncedProvider, modelSourceDigest, resolveSyncedProviders } from './index';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function fixture(
  providerOverrides: Readonly<Record<string, unknown>> = {},
  options: {
    readonly status?: number;
    readonly models?: readonly string[];
    readonly hooks?: ServerStateTestHooks;
  } = {},
) {
  let models = options.models ?? ['m-1'];
  let status = options.status ?? 200;
  let hits = 0;
  const fake = Bun.serve({
    port: 0,
    fetch(request) {
      if (!['/v1/models', '/models'].includes(new URL(request.url).pathname))
        return new Response(null, { status: 404 });
      hits++;
      return Response.json({ data: models.map((id) => ({ id })) }, { status });
    },
  });
  cleanups.push(() => void fake.stop(true));
  const home = mkdtempSync(join(tmpdir(), 'aio-provider-model-sync-'));
  cleanups.push(() => rmSync(home, { recursive: true, force: true }));
  const provider = {
    kind: 'api',
    protocol: 'openai-compatible',
    baseURL: fake.url.toString(),
    syncModels: true,
    ...providerOverrides,
  };
  const record = { providers: { relay: provider } };
  const configPath = join(home, 'config.json');
  await Bun.write(configPath, JSON.stringify(record));
  const stateOptions: InternalServerStateOptions = {
    config: ConfigSchema.parse(record),
    configPath,
    dbHome: home,
    watchConfig: false,
    builtIns: [],
    pluginLogger: () => {},
    logger: () => {},
    ...(options.hooks === undefined ? {} : { __test: options.hooks }),
  };
  const state = await createServerState(stateOptions);
  cleanups.push(state.close);
  return {
    state,
    home,
    fake,
    hits: () => hits,
    setModels(next: readonly string[]) {
      models = next;
    },
    setStatus(next: number) {
      status = next;
    },
  };
}

async function ids(state: ServerState) {
  return (await listModels(state)).data.map((row) => row.id);
}

async function summary(state: ServerState) {
  return (await state.providerSummaries({ probe: false })).find((row) => row.id === 'relay');
}

function expectRoutable(state: ServerState, model: string, upstream = model) {
  const lease = state.acquireProviderSnapshot();
  try {
    expect(lease.snapshot.router.resolve(model)[0]).toMatchObject({ provider: { id: 'relay' }, modelId: upstream });
  } finally {
    lease.release();
  }
}

test('a newly discovered model becomes routable without a config edit', async () => {
  const { state, setModels } = await fixture();
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(await ids(state)).toEqual(['m-1']);
  expect(await summary(state)).toMatchObject({
    state: { status: 'ready', catalog: 'fresh' },
    catalogLastSuccessAt: expect.any(String),
  });
  setModels(['m-1', 'm-2']);
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(await ids(state)).toContain('m-2');
  expectRoutable(state, 'm-2');
  expect(state.currentConfig().providers[0]?.models).toBeUndefined();
  const inventory = await state.modelRouting.list();
  expect(inventory.models.find((row) => row.modelId === 'm-2')?.providers[0]?.effective.eligible).toBe(true);
});

test('an upstream outage removes no route', async () => {
  const { state, setStatus } = await fixture();
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  const before = await ids(state);
  const refreshedAt = (await summary(state))?.catalogLastSuccessAt;
  setStatus(503);
  expect(await state.refreshProviderCatalog('relay')).toBe('failed');
  expect(await ids(state)).toEqual(before);
  expectRoutable(state, 'm-1');
  expect(await summary(state)).toMatchObject({
    catalogLastSuccessAt: refreshedAt,
    state: { status: 'ready', catalog: 'stale', diagnostic: { code: 'CATALOG_UNAVAILABLE' } },
  });
});

test('empty discovery keeps the last good list', async () => {
  const { state, setModels } = await fixture();
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  const before = await ids(state);
  setModels([]);
  expect(await state.refreshProviderCatalog('relay')).toBe('failed');
  expect(await ids(state)).toEqual(before);
  expectRoutable(state, 'm-1');
  expect(await summary(state)).toMatchObject({
    state: { status: 'ready', catalog: 'stale', diagnostic: { code: 'CATALOG_UNAVAILABLE' } },
  });
});

test.each(['baseURL', 'endpoint mode'])('source digest change hides the stored list: %s', async (change) => {
  const { state, fake, setStatus } = await fixture();
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(await ids(state)).toContain('m-1');
  setStatus(503);
  await state.configStore.mutateProviders(() => ({
    relay: {
      kind: 'api',
      syncModels: true,
      ...(change === 'baseURL'
        ? { protocol: 'openai-compatible', baseURL: new URL('/different', fake.url).toString() }
        : { endpoints: [{ protocol: 'openai-compatible', baseURL: fake.url.toString() }] }),
    },
  }));
  expect(await ids(state)).not.toContain('m-1');
  expect(await summary(state)).toMatchObject({
    state: { status: 'ready', catalog: 'stale', diagnostic: { code: 'CATALOG_UNAVAILABLE' } },
  });
  expect((await summary(state))?.catalogLastSuccessAt).toBeUndefined();
  expect((await state.modelRouting.list()).models.map((row) => row.modelId)).not.toContain('m-1');
});

test('first discovery failure keeps aliases eligible', async () => {
  const { state } = await fixture({ alias: { fast: { model: 'm-1' } } }, { status: 503 });
  expect(await state.refreshProviderCatalog('relay')).toBe('failed');
  expect(await ids(state)).toContain('fast');
  expectRoutable(state, 'fast', 'm-1');
  expect(await summary(state)).toMatchObject({
    state: { status: 'ready', catalog: 'stale', diagnostic: { code: 'CATALOG_UNAVAILABLE' } },
  });
  const inventory = await state.modelRouting.list();
  expect(inventory.models.find((row) => row.modelId === 'fast')?.providers[0]?.effective.eligible).toBe(true);
});

test('a disabled synced Provider refreshes manually but never on a timer', async () => {
  const { state, hits } = await fixture({ enabled: false });
  expect(hits()).toBe(0);
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(hits()).toBe(1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(hits()).toBe(1);
  expect(await summary(state)).toMatchObject({ state: { status: 'ready', catalog: 'fresh' } });
});

test('excluded model stays reachable through an alias', async () => {
  const { state } = await fixture({ excludedModels: ['m-1'], alias: { fast: { model: 'm-1' } } });
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(await ids(state)).toContain('fast');
  expect(await ids(state)).not.toContain('m-1');
  expectRoutable(state, 'fast', 'm-1');
  const inventory = await state.modelRouting.list();
  expect(inventory.models.map((row) => row.modelId)).toEqual(['fast']);
  expect(inventory.models[0]?.providers[0]?.effective.eligible).toBe(true);
});

test('static models are unchanged', async () => {
  const onCatalogJobsReplaced = mock(() => {});
  const { state, hits } = await fixture({ syncModels: undefined, models: ['x'] }, { hooks: { onCatalogJobsReplaced } });
  expect(await state.refreshProviderCatalog('relay')).toBe('unknown');
  expect(onCatalogJobsReplaced).toHaveBeenCalledWith([]);
  expect(hits()).toBe(0);
  expect(await ids(state)).toEqual(['x']);
  expectRoutable(state, 'x');
});

test('ids are listed in sorted order', async () => {
  const { state } = await fixture({}, { models: ['b', 'a', 'b'] });
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(await ids(state)).toEqual(['a', 'b']);
});

test('a first catalog is discovered automatically and a fresh list does not refresh again', async () => {
  const { state, hits } = await fixture();
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(await ids(state)).toEqual(['m-1']);
  expect(hits()).toBe(1);
  expect(await summary(state)).toMatchObject({ state: { status: 'ready', catalog: 'fresh' } });
});

test('a saved list is routed after restart without rediscovering a fresh catalog', async () => {
  const { state, home, hits, setStatus } = await fixture();
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  const config = state.currentConfig();
  const refreshedAt = (await summary(state))?.catalogLastSuccessAt;
  state.close();
  setStatus(503);
  const restarted = await createServerState({
    config,
    dbHome: home,
    builtIns: [],
    pluginLogger: () => {},
    logger: () => {},
  });
  cleanups.push(restarted.close);
  expect(await ids(restarted)).toEqual(['m-1']);
  expectRoutable(restarted, 'm-1');
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect(hits()).toBe(1);
  expect(await summary(restarted)).toMatchObject({
    catalogLastSuccessAt: refreshedAt,
    state: { status: 'ready', catalog: 'fresh' },
  });
});

test('rotating credentials retains the stored model list', async () => {
  const { state, fake, setStatus } = await fixture({ apiKey: 'old-credential' });
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  setStatus(503);
  await state.configStore.mutateProviders(() => ({
    relay: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: fake.url.toString(),
      syncModels: true,
      apiKey: 'new-credential',
    },
  }));
  expect(await ids(state)).toEqual(['m-1']);
  expectRoutable(state, 'm-1');
  expect(await summary(state)).toMatchObject({ state: { status: 'ready', catalog: 'fresh' } });
});

test('synced AI SDK Providers route their discovered catalog', async () => {
  const { state, fake } = await fixture({ enabled: false });
  await state.configStore.mutateProviders(() => ({
    relay: {
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
      options: { baseURL: fake.url.toString() },
      syncModels: true,
    },
  }));
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  expect(await ids(state)).toEqual(['m-1']);
  expectRoutable(state, 'm-1');
  expect(state.currentConfig().providers[0]?.models).toBeUndefined();
  expect((await state.modelRouting.list()).models[0]?.providers[0]?.effective.eligible).toBe(true);
});

test('unsupported AI SDK discovery preserves eligible aliases with its diagnostic', async () => {
  const { state, hits } = await fixture({ enabled: false });
  await state.configStore.mutateProviders(() => ({
    relay: { kind: 'ai-sdk', packageName: '@ai-sdk/openai', syncModels: true, alias: { fast: { model: 'm-1' } } },
  }));
  expect(await state.refreshProviderCatalog('relay')).toBe('failed');
  expect(await ids(state)).toEqual(['fast']);
  expectRoutable(state, 'fast', 'm-1');
  expect(await summary(state)).toMatchObject({
    state: { status: 'ready', catalog: 'stale', diagnostic: { code: 'CATALOG_UNSUPPORTED' } },
  });
  expect((await state.modelRouting.list()).models[0]?.providers[0]?.effective.eligible).toBe(true);
  expect(hits()).toBe(0);
});

test('a corrupt stored row cannot crash snapshot construction or routing inventory', async () => {
  const { state, home, setStatus } = await fixture({ alias: { fast: { model: 'm-1' } } }, { models: ['m-1', 'm-2'] });
  expect(await state.refreshProviderCatalog('relay')).toBe('refreshed');
  const handle = openDb({ home });
  try {
    handle.sqlite
      .query('UPDATE provider_model_catalog SET models_json = ? WHERE provider_id = ?')
      .run('{corrupt', 'relay');
  } finally {
    handle.close();
  }
  setStatus(503);
  expect((await state.modelRouting.list()).models.map((row) => row.modelId)).toEqual(['fast']);
  await state.configStore.mutateConfig((record) => ({ ...record, router: { models: {} } }));
  expect(await ids(state)).toEqual(['fast']);
  expectRoutable(state, 'fast', 'm-1');
  expect(await summary(state)).toMatchObject({
    state: { status: 'ready', catalog: 'stale', diagnostic: { code: 'CATALOG_UNAVAILABLE' } },
  });
});

test('static Providers never read synced model storage', () => {
  const repository: ProviderModelCatalogRepository = {
    read: mock(() => {
      throw new Error('must not read');
    }),
    writeSuccess: mock(() => {}),
    writeFailure: mock(() => {}),
  };
  const config = ConfigSchema.parse({
    providers: { relay: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.com', models: ['x'] } },
  });
  const resolved = resolveSyncedProviders(config, repository, createPluginDiagnosticFactory());
  expect(resolved.providers[0]).toBe(config.providers[0]);
  expect(resolved.jobs).toEqual([]);
  expect(repository.read).not.toHaveBeenCalled();
});

test('AI SDK source digests track the package and base URL without credentials', () => {
  const parse = (packageName: string, baseURL: string, apiKey: string) => {
    const provider = ConfigSchema.parse({
      providers: { relay: { kind: 'ai-sdk', packageName, options: { baseURL, apiKey }, syncModels: true } },
    }).providers[0];
    if (provider === undefined || !isSyncedProvider(provider)) throw new Error('expected a synced Provider');
    return provider;
  };
  const first = modelSourceDigest(parse('@ai-sdk/openai', 'https://example.com', 'old'));
  expect(modelSourceDigest(parse('@ai-sdk/openai', 'https://example.com', 'new'))).toBe(first);
  expect(modelSourceDigest(parse('@ai-sdk/openai', 'https://other.example.com', 'old'))).not.toBe(first);
  expect(modelSourceDigest(parse('@ai-sdk/openai-compatible', 'https://example.com', 'old'))).not.toBe(first);
});
