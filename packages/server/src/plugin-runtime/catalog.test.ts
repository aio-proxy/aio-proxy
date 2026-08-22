import { afterEach, expect, test } from 'bun:test';

import { ProviderKind } from '@aio-proxy/types';

import { cleanup, diagnostics, materializePluginProvider, runtimeFixture } from './test-support';

afterEach(cleanup);

test('an expired TTL catalog is ready but stale before a refresh diagnostic exists', async () => {
  const fixture = runtimeFixture({ kind: 'ttl', ttlMs: 1 });

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
  });

  expect(result.provider?.id).toBe('person');
  expect(result.state).toEqual({ status: 'ready', catalog: 'stale' });
});

test('a malformed stored catalog becomes unavailable and schedules safe rediscovery', async () => {
  const fixture = runtimeFixture({ kind: 'static' });
  fixture.repository.writeCatalog('person', { language: 'invalid' } as never, 1_000);

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
  });

  expect(result.provider).toBeUndefined();
  expect(result.state).toMatchObject({ status: 'unavailable', diagnostic: { code: 'CATALOG_UNAVAILABLE' } });
  expect(result.catalogJob).toBeDefined();
});

test('reused OAuth runtime refreshes priority and weight from the current config', async () => {
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

  const first = await materializePluginProvider({
    ...options,
    config: { ...base, priority: 2, weight: 4 },
  });
  const reused = await materializePluginProvider({
    ...options,
    config: { ...base, priority: 9, weight: 7 },
    previous: first.cacheEntry,
  });

  expect(fixture.createCalls()).toBe(1);
  expect(first.provider).toMatchObject({ priority: 2, weight: 4 });
  expect(reused.provider).toMatchObject({ priority: 9, weight: 7 });
  expect(reused.summary).toMatchObject({ priority: 9, weight: 7 });
  expect(reused.provider).not.toBe(first.provider);
});

test('an initially disabled provider validates state without creating runtime or catalog work', async () => {
  const fixture = runtimeFixture({ kind: 'ttl', ttlMs: 1 });

  const result = await materializePluginProvider({
    config: {
      id: 'person',
      kind: ProviderKind.OAuth,
      enabled: false,
      weight: 6,
      plugin: '@example/oauth',
      capability: 'default',
    },
    plugins: fixture.plugins,
    repository: fixture.repository,
    diagnostics,
    logger: () => {},
    onDiagnosticChanged: () => {},
  });

  expect(fixture.createCalls()).toBe(0);
  expect(result.provider).toBeUndefined();
  expect(result.catalogJob).toBeUndefined();
  expect(result.state).toMatchObject({ status: 'ready', catalog: 'stale' });
  expect(result.summary).toMatchObject({ weight: 6 });
  expect(result.summary).not.toHaveProperty('protocol');
  expect(result.summary).not.toHaveProperty('packageName');
});
