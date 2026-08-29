import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, type RawResolver, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema, ProviderProtocol } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { cleanup, deferred, seedOAuthAccount, waitUntil } from './test-support';

afterEach(cleanup);

test('migrates a persisted pre-rename catalog so raw protocol hints still resolve from extra', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-stale-catalog-migration-'));
  const configPath = join(home, 'config.json');
  const initialInput = {
    providers: {
      person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  repository.writeCatalog(
    'person',
    {
      language: [{ id: 'model', metadata: { protocol: 'anthropic' } }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    } as never,
    Date.now(),
  );

  const observed: unknown[] = [];
  const descriptor = definePlugin((api) => {
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
      async createRuntime() {
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
          raw(input: Parameters<RawResolver>[0]) {
            observed.push(input);
            return { invoke: async () => new Response('ok') };
          },
        } as never;
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
    pluginLogger: () => {},
  });

  try {
    const stored = repository.readCatalog('person');
    expect(stored?.catalog.language[0]).toEqual({ id: 'model', extra: { protocol: 'anthropic' } });
    expect('metadata' in (stored?.catalog ?? {})).toBe(false);

    const provider = state.currentProviderSnapshot().providers.find(({ id }) => id === 'person');
    expect(provider?.upstreamMetadata?.model?.protocol).toBe(ProviderProtocol.Anthropic);
    expect(provider?.model?.targetProtocol?.('model')).toBe(ProviderProtocol.Anthropic);

    const transport = provider?.raw?.resolve({ protocol: ProviderProtocol.OpenAICompatible, modelId: 'model' });
    expect(await transport?.invoke(new Request('https://example.test'))).toBeInstanceOf(Response);
    expect(observed[0]).toEqual({
      protocol: 'openai-compatible',
      modelId: 'model',
      extra: { protocol: 'anthropic' },
    });
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('removing an OAuth account during discovery discards the late catalog and cannot resurrect the provider', async () => {
  const home = mkdtempSync(join(tmpdir(), 'aio-proxy-remove-during-discovery-'));
  const configPath = join(home, 'config.json');
  const initialInput = {
    providers: {
      person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default' },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, 'missing');
  const discoveryStarted = deferred();
  const releaseDiscovery = deferred<{
    language: { id: string }[];
    image: never[];
    embedding: never[];
    speech: never[];
    transcription: never[];
    reranking: never[];
  }>();
  const descriptor = definePlugin((api) => {
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
          discoveryStarted.resolve();
          return releaseDiscovery.promise;
        },
      },
      async createRuntime() {
        throw new Error('must not run without a catalog');
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
    pluginLogger: () => {},
  });

  try {
    await discoveryStarted.promise;
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    expect(await state.reload()).toMatchObject({ ok: true });
    expect(state.currentProviderSnapshot().providers).toEqual([]);
    expect(() => state.currentProviderSnapshot().router.resolve('model')).toThrow();

    releaseDiscovery.resolve({
      language: [{ id: 'model' }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    await waitUntil(() => repository.readAccount('person') === null);
    await Bun.sleep(20);

    expect(repository.readCatalog('person')).toBeNull();
    expect(state.currentProviderSnapshot().providers).toEqual([]);
    expect(() => state.currentProviderSnapshot().router.resolve('model')).toThrow();
  } finally {
    releaseDiscovery.resolve({
      language: [],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
