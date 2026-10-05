import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository, createProviderModelCatalogRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { isSyncedProvider, modelSourceDigest } from '../../provider-model-sync';
import { createDashboardRoutes } from '../config';

type FixtureOptions = {
  readonly fail?: boolean;
  readonly enabled?: boolean;
};

async function createEditViewFixture(options: FixtureOptions = {}) {
  const { fail = false, enabled = true } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-edit-view-refresh-'));
  const handle = openDb({ home: dir });
  const repository = createPluginRepository(handle.sqlite);
  const pending = repository.stageAccountOperation({
    kind: 'create',
    targetDigest: 'seed',
    account: {
      providerId: 'person',
      plugin: '@example/oauth',
      capability: 'default',
      fingerprint: 'person@example.com',
      options: { tenant: 'work' },
      secrets: {},
      credential: { accessToken: 'stored-credential' },
      label: 'person@example.com',
      catalog: {
        kind: 'replace',
        value: {
          refreshedAt: Date.now(),
          catalog: {
            language: [{ id: 'model-1' }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
        },
      },
    },
  });
  repository.completeAccountOperation(pending.operationId);
  let discoveries = 0;
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: { options: { schema: zod.object({ tenant: zod.string() }), form: [] } },
      credentials: zod.object({ accessToken: zod.string() }),
      async login() {
        throw new Error('not used');
      },
      catalog: {
        // A day-long TTL with a catalog stored just now: nothing here is due on a timer, so any
        // discovery can only have come from the forced refresh the request asked for.
        policy: { kind: 'ttl', ttlMs: 24 * 60 * 60_000 },
        async discover() {
          discoveries++;
          if (fail) throw new Error('upstream refused');
          return {
            language: [{ id: 'model-1' }, { id: 'model-2' }],
            image: [{ id: 'gpt-image-2.5-sunburst' }],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          };
        },
      },
      async createRuntime() {
        return {
          provider: {
            specificationVersion: 'v4',
            languageModel() {
              throw new Error('not used');
            },
            imageModel() {
              throw new Error('not used');
            },
            embeddingModel() {
              throw new Error('not used');
            },
          },
        } as never;
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      plugins: ['@example/oauth'],
      providers: {
        person: {
          kind: 'oauth',
          plugin: '@example/oauth',
          capability: 'default',
          options: { tenant: 'work' },
          ...(enabled ? {} : { enabled: false }),
        },
        plain: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.com' },
      },
    }),
    pluginRepository: repository,
    watchConfig: false,
    pluginLogger: () => {},
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    routes,
    discoveries: () => discoveries,
    storedModelIds: () => repository.readCatalog('person')?.catalog.language.map(({ id }) => id),
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The refresh rides on a POST to the same path: the server's CSRF guard covers mutation methods only,
// so a side-effecting GET would be reachable cross-origin.
const editView = (
  routes: Awaited<ReturnType<typeof createEditViewFixture>>['routes'],
  id: string,
  refreshCatalog = false,
) => routes.request(`/providers/${id}/edit-view`, refreshCatalog ? { method: 'POST' } : undefined);

test('an ordinary edit-view read never touches upstream', async () => {
  const fixture = await createEditViewFixture();
  try {
    const response = await editView(fixture.routes, 'person');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { oauth: { models: string[] } };
    expect(body.oauth.models).toEqual(['model-1']);
    // The whole point of keeping the refresh on its own verb: opening the editor, saving, and every
    // invalidation hit this route, and none of them may provoke an upstream discovery.
    expect(fixture.discoveries()).toBe(0);
    expect(body).not.toHaveProperty('catalogRefreshed');
  } finally {
    fixture.cleanup();
  }
});

test('the refreshing POST rediscovers an unexpired catalog and answers with the new models', async () => {
  const fixture = await createEditViewFixture();
  try {
    const response = await editView(fixture.routes, 'person', true);

    expect(response.status).toBe(200);
    // The read happens after the refresh awaited its own snapshot rebuild, so these are the models the
    // proxy will actually route to.
    expect(await response.json()).toMatchObject({
      catalogRefreshed: true,
      oauth: { models: ['model-1', 'model-2', 'gpt-image-2.5-sunburst'] },
    });
    expect(fixture.discoveries()).toBe(1);
    expect(fixture.storedModelIds()).toEqual(['model-1', 'model-2']);
  } finally {
    fixture.cleanup();
  }
});

test('a disabled OAuth Provider can still be refreshed through the edit view', async () => {
  const fixture = await createEditViewFixture({ enabled: false });
  try {
    const response = await editView(fixture.routes, 'person', true);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ catalogRefreshed: true });
    expect(fixture.storedModelIds()).toEqual(['model-1', 'model-2']);
  } finally {
    fixture.cleanup();
  }
});

test('a failed discovery still answers the view, flagged, with the previous catalog', async () => {
  const fixture = await createEditViewFixture({ fail: true });
  try {
    const response = await editView(fixture.routes, 'person', true);

    // The view is readable, so the editor stays usable; only the reload it asked for failed.
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      catalogRefreshed: false,
      oauth: { models: ['model-1'] },
    });
    expect(fixture.storedModelIds()).toEqual(['model-1']);
  } finally {
    fixture.cleanup();
  }
});

test('a refresh POST for a static Provider is ignored rather than discovering anything', async () => {
  const fixture = await createEditViewFixture();
  try {
    const response = await editView(fixture.routes, 'plain', true);

    expect(response.status).toBe(200);
    expect(await response.json()).not.toHaveProperty('catalogRefreshed');
    expect(fixture.discoveries()).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

test('an unknown Provider ID answers 404 even when a refresh was asked for', async () => {
  const fixture = await createEditViewFixture();
  try {
    const response = await editView(fixture.routes, 'missing', true);

    expect(response.status).toBe(404);
    expect(fixture.discoveries()).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

async function createSyncedEditViewFixture() {
  let discoveries = 0;
  let status = 200;
  const fake = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== '/v1/models') return new Response(null, { status: 404 });
      discoveries++;
      return Response.json({ data: [{ id: 'm-2' }, { id: 'm-1' }, { id: 'm-2' }] }, { status });
    },
  });
  const home = mkdtempSync(join(tmpdir(), 'aio-dashboard-synced-edit-view-'));
  const configPath = join(home, 'config.json');
  const record = {
    providers: {
      relay: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: fake.url.toString(),
        syncModels: true,
        excludedModels: ['m-1'],
      },
      plain: { kind: 'api', protocol: 'openai-compatible', baseURL: fake.url.toString(), models: ['static'] },
    },
  };
  await Bun.write(configPath, JSON.stringify(record));
  const config = ConfigSchema.parse(record);
  const provider = config.providers.find(({ id }) => id === 'relay');
  if (provider === undefined || !isSyncedProvider(provider)) throw new Error('expected a synced Provider');
  const digest = modelSourceDigest(provider);
  const handle = openDb({ home });
  const repository = createProviderModelCatalogRepository(handle.sqlite);
  const refreshedAt = Date.now();
  // A fresh stored list prevents startup discovery, so only the POST can contact upstream.
  repository.writeSuccess('relay', digest, ['m-0'], refreshedAt);
  const state = await createServerState({
    config,
    configPath,
    dbHome: home,
    watchConfig: false,
    builtIns: [],
    logger: () => {},
    pluginLogger: () => {},
  });
  return {
    state,
    routes: createDashboardRoutes(state, disabledDashboardAuthentication),
    handle,
    repository,
    digest,
    discoveries: () => discoveries,
    refreshedAt: new Date(refreshedAt).toISOString(),
    setStatus(next: number) {
      status = next;
    },
    async cleanup() {
      state.close();
      handle.close();
      await fake.stop(true);
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('POST edit-view refreshes a synced api Provider', async () => {
  const fixture = await createSyncedEditViewFixture();
  try {
    const before = await editView(fixture.routes, 'relay');
    expect(await before.json()).toMatchObject({ sync: { models: ['m-0'], refreshedAt: fixture.refreshedAt } });
    expect(fixture.discoveries()).toBe(0);

    const response = await editView(fixture.routes, 'relay', true);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sync: { models: string[]; refreshedAt: string } };
    expect(body).toMatchObject({ catalogRefreshed: true, sync: { models: ['m-1', 'm-2'] } });
    expect(new Date(body.sync.refreshedAt).toISOString()).toBe(body.sync.refreshedAt);
    expect(fixture.discoveries()).toBe(1);
    expect(fixture.state.currentConfig().providers.find(({ id }) => id === 'relay')?.models).toBeUndefined();

    const plain = await editView(fixture.routes, 'plain');
    expect(await plain.json()).not.toHaveProperty('sync');
  } finally {
    await fixture.cleanup();
  }
});

test.each(['missing', 'different digest', 'missing list', 'corrupt'])(
  'synced edit-view returns an empty list without a refresh time for a %s catalog',
  async (stored) => {
    const fixture = await createSyncedEditViewFixture();
    try {
      if (stored === 'missing') {
        fixture.handle.sqlite.query('DELETE FROM provider_model_catalog WHERE provider_id = ?').run('relay');
      } else if (stored === 'different digest') {
        fixture.repository.writeSuccess('relay', 'old-source', ['old-model'], Date.now());
      } else if (stored === 'missing list') {
        fixture.repository.writeFailure('relay', 'old-source', 'CATALOG_UNAVAILABLE', Date.now());
        fixture.repository.writeFailure('relay', fixture.digest, 'CATALOG_UNAVAILABLE', Date.now());
      } else {
        fixture.handle.sqlite
          .query('UPDATE provider_model_catalog SET models_json = ? WHERE provider_id = ?')
          .run('invalid-json', 'relay');
      }
      const response = await editView(fixture.routes, 'relay');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { sync: unknown };
      expect(body.sync).toEqual({ models: [] });
      expect(fixture.discoveries()).toBe(0);
    } finally {
      await fixture.cleanup();
    }
  },
);

test('a static Provider edit view never reads synced catalog storage', async () => {
  const fixture = await createSyncedEditViewFixture();
  try {
    fixture.handle.sqlite.run('DROP TABLE provider_model_catalog');
    expect(fixture.state.syncedProviderEditView('plain')).toBeUndefined();
    const response = await editView(fixture.routes, 'plain', true);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toHaveProperty('sync');
    expect(body).not.toHaveProperty('catalogRefreshed');
    expect(fixture.discoveries()).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});

test('a failed synced catalog refresh keeps the previous list and refresh time', async () => {
  const fixture = await createSyncedEditViewFixture();
  try {
    fixture.setStatus(503);
    const response = await editView(fixture.routes, 'relay', true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      catalogRefreshed: false,
      sync: { models: ['m-0'], refreshedAt: fixture.refreshedAt },
    });
    expect(fixture.discoveries()).toBe(1);
  } finally {
    await fixture.cleanup();
  }
});

test('edit-view reads the Provider and routing after a catalog refresh changes config', async () => {
  const fixture = await createSyncedEditViewFixture();
  try {
    const state = fixture.state;
    const routes = createDashboardRoutes(
      {
        ...state,
        async refreshProviderCatalog(id) {
          const result = await state.refreshProviderCatalog(id);
          await state.configStore.mutateProviders((providers) => ({
            ...providers,
            relay: { ...(providers['relay'] as object), excludedModels: ['m-2'], priority: 7 },
          }));
          return result;
        },
      },
      disabledDashboardAuthentication,
    );
    const response = await editView(routes, 'relay', true);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      provider: { excludedModels: ['m-2'], priority: 7 },
      sync: { models: ['m-1', 'm-2'] },
      routing: await state.modelRouting.providerNumberViews('relay'),
      catalogRefreshed: true,
    });
  } finally {
    await fixture.cleanup();
  }
});

test('edit-view answers 404 when the Provider disappears during refresh', async () => {
  const fixture = await createSyncedEditViewFixture();
  try {
    const state = fixture.state;
    const routes = createDashboardRoutes(
      {
        ...state,
        async refreshProviderCatalog(id) {
          const result = await state.refreshProviderCatalog(id);
          await state.configStore.mutateProviders(() => ({}));
          return result;
        },
      },
      disabledDashboardAuthentication,
    );
    const response = await editView(routes, 'relay', true);
    expect(response.status).toBe(404);
  } finally {
    await fixture.cleanup();
  }
});
