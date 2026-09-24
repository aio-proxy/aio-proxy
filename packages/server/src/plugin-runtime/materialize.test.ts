import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPluginRegistry, resolveNativeProxyUrl, Router } from '@aio-proxy/core';
import { definePlugin, type RuntimeFetch, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, ProviderKind } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

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

test('a proxy-unsupported adapter is unavailable before catalog or runtime work', async () => {
  let discoveries = 0;
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      catalog: null,
      supportsProxy: false,
      discover: async () => {
        discoveries++;
        throw new Error('catalog discovery must not run');
      },
    },
  );
  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    effectiveProxy: 'https://proxy-user:proxy-password@proxy.example:8443',
  });

  expect(result.provider).toBeUndefined();
  expect(result.catalogJob).toBeUndefined();
  expect(result.state).toMatchObject({
    status: 'unavailable',
    diagnostic: { code: 'PROXY_UNSUPPORTED', retryable: false },
  });
  expect(fixture.createCalls()).toBe(0);
  expect(discoveries).toBe(0);
  expect(JSON.stringify(result)).not.toContain('proxy-password');
  expect(JSON.stringify(result)).not.toContain('proxy.example');
});

test('a proxy-unsupported adapter remains available without an effective proxy', async () => {
  const fixture = runtimeFixture({ kind: 'static' }, { supportsProxy: false });
  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: true,
      plugin: '@example/oauth',
      capability: 'default',
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    effectiveProxy: null,
  });

  expect(result.state).toMatchObject({ status: 'ready' });
  expect(result.provider).toBeDefined();
  expect(fixture.createCalls()).toBe(1);
});

test.each([
  'https://provider-proxy.example:8443',
  'socks5://user:password@proxy.example:1080',
  'http://fallback-primary.example:8080',
])('the provider key and %s override reach OAuth fetch and socket transports', async (providerProxy) => {
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
  let socketProxy: string | null | undefined;
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
        socketProxy = context.proxy;
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
        proxyBackup: 'socks5://global-backup.example:1080',
        proxyFallback: true,
        providers: {
          'configured-key': {
            kind: 'oauth',
            plugin: '@example/oauth',
            capability: 'default',
            proxy: providerProxy,
            ...(providerProxy.includes('fallback-primary')
              ? { proxyBackup: 'socks5://own-backup.example:1080', proxyFallback: true }
              : {}),
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
    const nativeProxy = await resolveNativeProxyUrl(
      providerProxy.includes('fallback-primary')
        ? { primary: providerProxy, backup: 'socks5://own-backup.example:1080' }
        : providerProxy,
    );
    expect(proxies).toEqual([nativeProxy, nativeProxy]);
    expect(socketProxy).toBe(nativeProxy);
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
    const backup = 'socks5://backup.proxy.example:1080';
    for (const [enabled, count] of [
      [true, 3],
      [false, 4],
    ] as const) {
      writeFileSync(
        configPath,
        JSON.stringify({ ...configInput(secondProxy), proxyBackup: backup, proxyFallback: enabled }),
      );
      expect((await state.reload()).ok).toBe(true);
      expect(runtimeFetches).toHaveLength(count);
      proxies.length = 0;
      await runtimeFetches[count - 1]?.('https://oauth.example/models');
      expect(proxies).toEqual([await resolveNativeProxyUrl(enabled ? { primary: secondProxy, backup } : secondProxy)]);
    }
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
    config: { ...base, enabled: true },
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
    },
    previous: disabled.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(1);
  expect(disabled.provider).toBeUndefined();
  expect(disabled.cacheEntry?.provider).toMatchObject({ enabled: false, alias: { client: { model: 'model' } } });
  expect(reenabled.provider).toMatchObject({ enabled: true, alias: { client: { model: 'model' } } });
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

test('a quota-capable adapter keeps its quota capability across account preparation failures', async () => {
  const quota = { read: async () => ({ items: [] }) };
  const refreshCredential = async () => ({ value: { token: 'rotated' } });
  const config = {
    id: 'person',
    kind: ProviderKind.OAuth,
    enabled: true,
    plugin: '@example/oauth',
    capability: 'default',
  } as const;
  const base = { config, diagnostics, logger: () => {}, onDiagnosticChanged: () => {} } as const;

  // The account belongs to another provider id, so `readAccount('person')` finds nothing.
  const missing = runtimeFixture({ kind: 'static' }, { providerId: 'someone-else', quota, refreshCredential });
  const missingResult = await materializePluginProvider({
    ...base,
    plugins: missing.plugins,
    repository: missing.repository,
  });

  const invalidOptions = runtimeFixture(
    { kind: 'static' },
    { accountOptionsSchema: zod.object({ region: zod.string() }), quota, refreshCredential },
  );
  const invalidOptionsResult = await materializePluginProvider({
    ...base,
    plugins: invalidOptions.plugins,
    repository: invalidOptions.repository,
  });

  expect(missingResult.state).toMatchObject({ diagnostic: { code: 'CREDENTIALS_MISSING_OR_INVALID' } });
  expect(missingResult.summary.hasQuota).toBe(true);
  expect(missingResult.summary.canRefreshCredential).toBe(true);
  expect(invalidOptionsResult.state).toMatchObject({ diagnostic: { code: 'ACCOUNT_OPTIONS_INVALID' } });
  expect(invalidOptionsResult.summary.hasQuota).toBe(true);
  expect(invalidOptionsResult.summary.canRefreshCredential).toBe(true);
});

test('stamps the account pin and hands the effective proxy to the plugin runtime', async () => {
  const seen: { proxy?: string | null } = {};
  const fixture = runtimeFixture(
    { kind: 'static' },
    {
      createRuntime(context: { readonly proxy?: string | null }) {
        seen.proxy = context.proxy;
        return {
          genAiProviderName: 'openrouter',
          provider: {
            specificationVersion: 'v4' as const,
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
    },
  );

  const result = await materializePluginProvider({
    config: { id: 'person', kind: ProviderKind.OAuth, enabled: true, plugin: '@example/oauth', capability: 'default' },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
    effectiveProxy: 'http://127.0.0.1:8123',
  });

  const account = fixture.repository.readAccount('person');
  expect(seen.proxy).toBe('http://127.0.0.1:8123');
  expect(result.provider?.accountId).toBe('person@example.com');
  expect(result.provider?.runtimeRevision).toBe(account?.runtimeRevision);
  expect(Reflect.get(result.provider ?? {}, 'genAiProviderName')).toBe('openrouter');
});

test('injects a source-bound private evaluator only into the built-in ChatGPT context', async () => {
  for (const [plugin, builtIn] of [
    ['@example/oauth', false],
    ['@aio-proxy/plugin-openai-chatgpt', false],
    ['@aio-proxy/plugin-openai-chatgpt', true],
  ] as const) {
    let context: unknown;
    const fixture = runtimeFixture(
      { kind: 'static' },
      {
        createRuntime: async (value) => {
          context = value;
          return {
            provider: {
              specificationVersion: 'v4',
              languageModel() {
                throw new Error('unused');
              },
              imageModel() {
                throw new Error('unused');
              },
              embeddingModel() {
                throw new Error('unused');
              },
            },
          } as never;
        },
      },
    );
    const account = fixture.repository.readAccount('person')!;
    const adapter = fixture.plugins.registry.resolveOAuth('@example/oauth', 'default')!;
    const calls: string[] = [];
    const evaluate = async () => 'evaluated';
    const result = await materializePluginProvider({
      config: { id: 'person', kind: ProviderKind.OAuth, enabled: true, plugin, capability: 'default' },
      repository: { ...fixture.repository, readAccount: () => ({ ...account, plugin }) },
      plugins: {
        ...fixture.plugins,
        plugins: new Map([[plugin, { packageName: plugin, builtIn, version: '1.0.0', state: { status: 'ready' } }]]),
        registry: { ...fixture.plugins.registry, resolveOAuth: () => adapter },
      },
      diagnostics,
      logger: () => {},
      onDiagnosticChanged: () => {},
      guardianEvaluate: (sourceProviderId) => {
        calls.push(sourceProviderId);
        return evaluate;
      },
    });
    expect(result.provider).toBeDefined();
    const injected = (context as { __aioGuardianEvaluate?: unknown }).__aioGuardianEvaluate;
    if (plugin === '@example/oauth' || !builtIn) {
      expect(injected).toBeUndefined();
      expect(calls).toEqual([]);
    } else {
      expect(injected).toBe(evaluate);
      expect(calls).toEqual(['person']);
    }
  }
});
