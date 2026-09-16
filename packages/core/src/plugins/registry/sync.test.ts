import { expect, test } from 'bun:test';

import { definePlugin } from '@aio-proxy/plugin-sdk';
import { z } from 'zod';

import { createMemorySyncBackend } from '../../sync/test-support';
import { loadPluginRegistry } from '../loader/index';
import { createPluginRegistryHost } from '../registry';

const options = { schema: z.object({}), form: [] };

test('validation registers a backend without connecting', () => {
  const host = createPluginRegistryHost();
  const stage = host.stage('@example/sync');
  let connections = 0;
  stage.api.sync.register({
    id: 'memory',
    displayName: 'Memory',
    options,
    async connect() {
      connections++;
      return createMemorySyncBackend().connect();
    },
  });
  stage.seal();
  stage.commit();

  expect(host.registry.resolveSync('@example/sync', 'memory')).toBeDefined();
  expect(connections).toBe(0);
});

test('an OAuth-only plugin remains loadable without a sync registration', async () => {
  const snapshot = await loadPluginRegistry({
    builtIns: [
      {
        packageName: '@example/oauth-only',
        version: '1.0.0',
        descriptor: definePlugin((api) => {
          void api.oauth;
        }),
      },
    ],
    enablements: [{ packageName: '@example/oauth-only' }],
    diagnostics: (code, options) => ({
      code,
      retryable: options.retryable,
      summary: code,
      occurredAt: new Date(0).toISOString(),
    }),
    importPackage: async () => {
      throw new Error('built-in descriptor should not be imported');
    },
    logger: () => {},
    secrets: { readPluginSecret: () => undefined },
  });

  expect(snapshot.plugins.get('@example/oauth-only')?.state.status).toBe('ready');
  expect(snapshot.registry.syncCapabilities()).toHaveLength(0);
});

test('discarded staging leaves no sync capabilities', () => {
  const host = createPluginRegistryHost();
  const stage = host.stage('@example/sync');
  stage.api.sync.register({
    id: 'memory',
    displayName: 'Memory',
    options,
    connect: async () => createMemorySyncBackend().connect(),
  });

  expect(host.registry.resolveSync('@example/sync', 'memory')).toBeUndefined();
});

test('sync registration rejects duplicate capability IDs and registration after seal', () => {
  const stage = createPluginRegistryHost().stage('@example/sync');
  const backend = {
    id: 'memory',
    displayName: 'Memory',
    options,
    connect: async () => createMemorySyncBackend().connect(),
  };
  stage.api.sync.register(backend);
  expect(() => stage.api.sync.register(backend)).toThrow('Duplicate sync capability');
  stage.seal();
  expect(() => stage.api.sync.register({ ...backend, id: 'other' })).toThrow('Plugin staging registry is sealed');
});

test('resolved backend binds the plugin receiver and rejects invalid sessions', async () => {
  class Backend {
    readonly id = 'bound';
    readonly displayName = 'Bound';
    readonly options = options;
    readonly marker = 'bound receiver';

    async connect() {
      if (this.marker !== 'bound receiver') throw new Error('lost receiver');
      return { identityId: '', spaceId: 'space', maxValueBytes: 1, async dispose() {} };
    }
  }
  const host = createPluginRegistryHost();
  const stage = host.stage('@example/sync');
  stage.api.sync.register(new Backend());
  stage.seal();
  stage.commit();

  const backend = host.registry.resolveSync('@example/sync', 'bound');
  await expect(backend?.connect({}, { signal: new AbortController().signal, dataDirectory: '/tmp' })).rejects.toThrow(
    'Invalid sync session',
  );
});

test('two clients cannot both create the same key', async () => {
  const backend = createMemorySyncBackend();
  const a = backend.connect();
  const b = backend.connect();
  const signal = new AbortController().signal;
  const value = new TextEncoder().encode('secret');
  const results = await Promise.all([
    a.compareAndSwap('k', null, value, signal),
    b.compareAndSwap('k', null, value, signal),
  ]);

  expect(results.filter((result) => result.kind === 'written')).toHaveLength(1);
  expect(results.filter((result) => result.kind === 'conflict')).toHaveLength(1);
});
