import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPluginRegistry, Router } from '@aio-proxy/core';
import { definePlugin, type RuntimeFetch, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, ProviderKind } from '@aio-proxy/types';

import { createServerState } from '../server-state';
import { cleanup, diagnostics, homes, materializePluginProvider, runtimeFixture } from './test-support';

afterEach(cleanup);

test('a missing plugin degrades only its structured OAuth provider', async () => {
  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/missing',
      capability: 'default',
    },
    plugins: {
      plugins: new Map(),
      registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] },
    },
    repository: {} as never,
    diagnostics: (code, options) => ({
      code,
      summary: `${code}:${options.providerId ?? ''}`,
      retryable: options.retryable,
      occurredAt: new Date(0).toISOString(),
    }),
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(result.provider).toBeUndefined();
  expect(result.state).toMatchObject({ status: 'unavailable', diagnostic: { code: 'PLUGIN_NOT_INSTALLED' } });
  expect(result.summary).toMatchObject({ id: 'person', enabled: true, clientModels: [] });
});

test('runtime creation timeout isolates a hung provider from another provider materialization', async () => {
  const hung = runtimeFixture({ kind: 'static' }, { createRuntime: async () => new Promise<never>(() => {}) });
  const fast = runtimeFixture({ kind: 'static' });
  const options = {
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
    },
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  } as const;
  let hungSettled = false;
  const hungResult = materializePluginProvider({ ...options, repository: hung.repository, plugins: hung.plugins });
  void hungResult.then(() => {
    hungSettled = true;
  });
  const fastResult = await materializePluginProvider({
    ...options,
    repository: fast.repository,
    plugins: fast.plugins,
  });

  expect(fastResult.state).toMatchObject({ status: 'ready' });
  expect(hungSettled).toBe(false);
  expect((await hungResult).state).toMatchObject({
    status: 'unavailable',
    diagnostic: { code: 'RUNTIME_CREATE_FAILED' },
  });
}, 7_000);

test('the provider config key and proxy override reach the materialized OAuth runtime', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { providerId: 'configured-key' });
  const serverHome = mkdtempSync(join(tmpdir(), 'aio-proxy-plugin-runtime-server-'));
  homes.push(serverHome);
  const originalFetch = globalThis.fetch;
  const proxies: (string | undefined)[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
      proxies.push(init?.proxy);
      return new Response(null, { status: 204 });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
  let runtimeFetch: RuntimeFetch | undefined;
  const descriptor = definePlugin<unknown>((api) => {
    api.oauth.register({
      id: 'default',
      displayName: 'Example',
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error('not called');
      },
      catalog: {
        policy: { kind: 'static' },
        async discover() {
          throw new Error('stored catalog should be used');
        },
      },
      async createRuntime(context) {
        runtimeFetch = context.fetch;
        return {
          provider: {
            specificationVersion: 'v4',
            languageModel() {
              throw new Error('not called');
            },
            imageModel() {
              throw new Error('not called');
            },
            embeddingModel() {
              throw new Error('not called');
            },
          },
        } as never;
      },
    });
  });
  let state: Awaited<ReturnType<typeof createServerState>> | undefined;
  try {
    state = await createServerState({
      config: ConfigSchema.parse({
        proxy: 'https://global-proxy.example:8443',
        providers: {
          'configured-key': {
            kind: 'oauth',
            plugin: '@example/oauth',
            capability: 'default',
            proxy: 'https://provider-proxy.example:8443',
          },
        },
      }),
      dbHome: serverHome,
      pluginRepository: fixture.repository,
      builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
      pluginLogger: () => {},
    });

    const snapshot = state.currentProviderSnapshot();
    expect(snapshot.providers[0]?.id).toBe('configured-key');
    expect(snapshot.providerStates?.get('configured-key')).toEqual({ status: 'ready', catalog: 'fresh' });
    expect(snapshot.providerStates?.has('person')).toBe(false);
    expect(snapshot.router.resolve('model')[0]?.provider.id).toBe('configured-key');
    if (runtimeFetch === undefined) throw new Error('OAuth runtime fetch was not captured');
    proxies.length = 0;
    await runtimeFetch('https://oauth.example/token', { aioProxy: { traffic: 'control' } });
    await runtimeFetch('https://oauth.example/models');
    expect(proxies).toEqual(['https://provider-proxy.example:8443', 'https://provider-proxy.example:8443']);
  } finally {
    state?.close();
    globalThis.fetch = originalFetch;
  }
});

test('a global proxy reload rebuilds an OAuth runtime that inherits the proxy', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { providerId: 'configured-key' });
  const serverHome = mkdtempSync(join(tmpdir(), 'aio-proxy-plugin-runtime-global-proxy-'));
  const configPath = join(serverHome, 'config.json');
  homes.push(serverHome);
  const originalFetch = globalThis.fetch;
  const proxies: (string | undefined)[] = [];
  globalThis.fetch = Object.assign(
    async (_input: RequestInfo | URL, init?: RequestInit & { proxy?: string }) => {
      proxies.push(init?.proxy);
      return new Response(null, { status: 204 });
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof globalThis.fetch;
  const runtimeFetches: RuntimeFetch[] = [];
  const descriptor = definePlugin<unknown>((api) => {
    api.oauth.register({
      id: 'default',
      displayName: 'Example',
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error('not called');
      },
      catalog: {
        policy: { kind: 'static' },
        async discover() {
          throw new Error('stored catalog should be used');
        },
      },
      async createRuntime(context) {
        runtimeFetches.push(context.fetch);
        return {
          provider: {
            specificationVersion: 'v4',
            languageModel() {
              throw new Error('not called');
            },
            imageModel() {
              throw new Error('not called');
            },
            embeddingModel() {
              throw new Error('not called');
            },
          },
        } as never;
      },
    });
  });
  const configInput = (proxy: string) => ({
    proxy,
    providers: {
      'configured-key': {
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: 'default',
      },
    },
  });
  const firstProxy = 'https://first-global-proxy.example:8443';
  const secondProxy = 'https://second-global-proxy.example:8443';
  writeFileSync(configPath, JSON.stringify(configInput(firstProxy)));
  let state: Awaited<ReturnType<typeof createServerState>> | undefined;

  try {
    state = await createServerState({
      config: ConfigSchema.parse(configInput(firstProxy)),
      configPath,
      dbHome: serverHome,
      watchConfig: false,
      pluginRepository: fixture.repository,
      builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
      pluginLogger: () => {},
    });
    expect(runtimeFetches).toHaveLength(1);
    proxies.length = 0;
    await runtimeFetches[0]?.('https://oauth.example/models');
    expect(proxies).toEqual([firstProxy]);

    writeFileSync(configPath, JSON.stringify(configInput(secondProxy)));
    expect((await state.reload()).ok).toBe(true);
    expect(runtimeFetches).toHaveLength(2);
    proxies.length = 0;
    await runtimeFetches[1]?.('https://oauth.example/models');
    expect(proxies).toEqual([secondProxy]);
  } finally {
    state?.close();
    globalThis.fetch = originalFetch;
  }
});

test('a materialized OAuth provider obeys real Router self, rename, and preserve aliases', async () => {
  const fixture = runtimeFixture({ kind: 'static' });
  const base = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: '@example/oauth',
    capability: 'default',
  } as const;
  const options = {
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  };
  const direct = await materializePluginProvider({ ...options, config: base });
  const renamed = await materializePluginProvider({
    ...options,
    config: { ...base, alias: { renamed: { model: 'model', preserve: false } } },
    previous: direct.cacheEntry,
  });
  const preserved = await materializePluginProvider({
    ...options,
    config: { ...base, alias: { kept: { model: 'model', preserve: true } } },
    previous: renamed.cacheEntry,
  });
  if (direct.provider === undefined || renamed.provider === undefined || preserved.provider === undefined) {
    throw new Error('runtime fixture did not materialize providers');
  }
  const directRouter = new Router([direct.provider]);
  const renamedRouter = new Router([renamed.provider]);
  const preservedRouter = new Router([preserved.provider]);

  expect(directRouter.resolve('model')[0]?.modelId).toBe('model');
  expect(renamedRouter.resolve('renamed')[0]?.modelId).toBe('model');
  expect(() => renamedRouter.resolve('model')).toThrow();
  expect(preservedRouter.resolve('kept')[0]?.modelId).toBe('model');
  expect(preservedRouter.resolve('model')[0]?.modelId).toBe('model');
});

test('disabling and re-enabling reuses the runtime while updating enabled and aliases', async () => {
  const fixture = runtimeFixture({ kind: 'static' });
  const base = {
    id: 'person',
    kind: ProviderKind.OAuth,
    plugin: '@example/oauth',
    capability: 'default',
  } as const;
  const options = {
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  };

  const enabled = await materializePluginProvider({
    ...options,
    config: { ...base, enabled: true, metadata: { model: { name: 'Before' } } },
  });
  const disabled = await materializePluginProvider({
    ...options,
    config: { ...base, enabled: false, alias: { client: { model: 'model', preserve: false } } },
    previous: enabled.cacheEntry,
  });
  const reenabled = await materializePluginProvider({
    ...options,
    config: {
      ...base,
      enabled: true,
      alias: { client: { model: 'model', preserve: false } },
      metadata: { model: { name: 'After' } },
    },
    previous: disabled.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(1);
  expect(disabled.provider).toBeUndefined();
  expect(disabled.cacheEntry?.provider).toMatchObject({ enabled: false, alias: { client: { model: 'model' } } });
  expect(reenabled.provider).toMatchObject({ enabled: true, alias: { client: { model: 'model' } } });
  expect(reenabled.provider?.configMetadata?.model?.name).toBe('After');
});

test('plugin descriptor import is cached while setup runs for every registry snapshot', async () => {
  let imports = 0;
  let setups = 0;
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-plugin-import-cache-'));
  const packageName = '@example/cache-test';
  const packageDir = join(home, 'packages', encodeURIComponent(packageName), 'node_modules', '@example', 'cache-test');
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ version: '1.0.0', main: 'index.js' }));
  writeFileSync(join(packageDir, 'index.js'), 'export default {};');
  const aioProxyHome = 'AIO_PROXY_HOME';
  const previousHome = process.env[aioProxyHome];
  process.env[aioProxyHome] = home;
  const descriptor = definePlugin(() => {
    setups++;
  });
  const options = {
    enablements: [{ packageName }],
    builtIns: [],
    diagnostics,
    importPackage: async () => {
      imports++;
      return { default: descriptor };
    },
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  } as const;

  try {
    await loadPluginRegistry(options);
    await loadPluginRegistry(options);

    expect(imports).toBe(1);
    expect(setups).toBe(2);
  } finally {
    if (previousHome === undefined) delete process.env[aioProxyHome];
    else process.env[aioProxyHome] = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});

test('plugin removal drops the runtime capability without deleting the account', async () => {
  const fixture = runtimeFixture({ kind: 'static' });
  const config = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: '@example/oauth',
    capability: 'default',
  } as const;
  const first = await materializePluginProvider({
    config,
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });
  const removed = await materializePluginProvider({
    config,
    plugins: { plugins: new Map(), registry: { resolveOAuth: () => undefined, oauthCapabilities: () => [] } },
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    previous: first.cacheEntry,
  });

  expect(removed.provider).toBeUndefined();
  expect(removed.state).toMatchObject({ diagnostic: { code: 'PLUGIN_NOT_INSTALLED' } });
  expect(fixture.repository.readAccount('person')).not.toBeNull();
});
