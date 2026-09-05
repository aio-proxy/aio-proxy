import { afterEach, expect, test } from 'bun:test';

import type { ModelCatalog } from '@aio-proxy/plugin-sdk';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { catalogFreshness, modelMetadataRecord } from './catalog';
import { catalog, cleanup, diagnostics, materializePluginProvider, runtimeFixture } from './test-support';

const emptyFamilies = {
  image: [],
  speech: [],
  transcription: [],
  reranking: [],
} as const satisfies Pick<ModelCatalog, 'image' | 'speech' | 'transcription' | 'reranking'>;

afterEach(cleanup);

test('overlapping catalog IDs keep the language protocol for language targetProtocol', () => {
  expect(
    modelMetadataRecord({
      ...emptyFamilies,
      language: [
        { id: 'shared', displayName: 'Chat', extra: { protocol: ProviderProtocol.OpenAIResponse } },
        { id: 'chat-only', extra: { protocol: ProviderProtocol.Anthropic } },
      ],
      embedding: [
        { id: 'shared', displayName: 'Embed', extra: { protocol: ProviderProtocol.Gemini } },
        { id: 'embed-only', extra: { protocol: ProviderProtocol.OpenAICompatible } },
      ],
    }),
  ).toEqual({
    'chat-only': { protocol: ProviderProtocol.Anthropic },
    'embed-only': { protocol: ProviderProtocol.OpenAICompatible },
    shared: { name: 'Chat', protocol: ProviderProtocol.OpenAIResponse },
  });
});

test('overlapping language and image catalog IDs keep the language protocol', () => {
  expect(
    modelMetadataRecord({
      ...emptyFamilies,
      language: [{ id: 'shared', displayName: 'Chat', extra: { protocol: ProviderProtocol.Anthropic } }],
      image: [{ id: 'shared', displayName: 'Image', extra: { protocol: ProviderProtocol.OpenAIImage } }],
      embedding: [],
    }),
  ).toEqual({
    shared: { name: 'Chat', protocol: ProviderProtocol.Anthropic },
  });
});

test('overlapping catalog IDs drop embedding protocol when language omits it', () => {
  expect(
    modelMetadataRecord({
      ...emptyFamilies,
      language: [{ id: 'shared' }],
      embedding: [{ id: 'shared', displayName: 'Embed', extra: { protocol: ProviderProtocol.Gemini } }],
    }),
  ).toEqual({
    shared: { name: 'Embed' },
  });
});

test('descriptor modelMetadata feeds upstream metadata with displayName winning the name', () => {
  expect(
    modelMetadataRecord({
      ...emptyFamilies,
      language: [
        {
          id: 'm1',
          displayName: 'Display',
          extra: { protocol: ProviderProtocol.Anthropic },
          modelMetadata: { name: 'Ignored', limit: { context: 100_000 } },
        },
      ],
      embedding: [],
    }),
  ).toEqual({
    m1: { name: 'Display', protocol: ProviderProtocol.Anthropic, limit: { context: 100_000 } },
  });
});

test('overlapping language and image descriptors merge typed fields, language winning, protocol from language only', () => {
  const record = modelMetadataRecord({
    ...emptyFamilies,
    image: [
      {
        id: 'm1',
        extra: { protocol: ProviderProtocol.OpenAIImage },
        modelMetadata: { name: 'Image', cost: { image: 0.04 } },
      },
    ],
    language: [{ id: 'm1', modelMetadata: { limit: { context: 100_000 } } }],
    embedding: [],
  });
  // Image-only fields survive, language fields merge in, and the image
  // descriptor's extra.protocol does NOT survive — language owns protocol.
  expect(record['m1']).toEqual({
    name: 'Image',
    cost: { image: 0.04 },
    limit: { context: 100_000 },
  });
});

test('a migrated catalog with revision 0 is stale even inside the TTL window', () => {
  expect(
    catalogFreshness(
      { kind: 'ttl', ttlMs: 6 * 60 * 60_000 },
      { catalog, refreshedAt: Date.now(), revision: 0 },
      undefined,
    ),
  ).toBe('stale');
});

test('a migrated static catalog with revision 0 stays fresh', () => {
  expect(catalogFreshness({ kind: 'static' }, { catalog, refreshedAt: Date.now(), revision: 0 }, undefined)).toBe(
    'fresh',
  );
});

test('materialize binds plugin capability runtimeRevision onto the catalog job', async () => {
  const fixture = runtimeFixture({ kind: 'ttl', ttlMs: 1 });
  const account = fixture.repository.readAccount('person');

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

  expect(result.catalogJob?.plugin).toBe('@example/oauth');
  expect(result.catalogJob?.capability).toBe('default');
  expect(result.catalogJob?.accountRuntimeRevision).toBe(account?.runtimeRevision);
  expect(result.catalogJob).not.toHaveProperty('defaultAliases');
});

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

test('an initially disabled provider validates state without creating a runtime or arming its catalog', async () => {
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
  // The job exists so a manual catalog refresh can reach a disabled Provider, but it carries
  // `enabled: false`, which is what keeps the scheduler from ever arming a timer for it.
  expect(result.catalogJob).toMatchObject({ providerId: 'person', enabled: false });
  expect(result.state).toMatchObject({ status: 'ready', catalog: 'stale' });
  expect(result.summary).toMatchObject({ weight: 6 });
  expect(result.summary).not.toHaveProperty('protocol');
  expect(result.summary).not.toHaveProperty('packageName');
});
