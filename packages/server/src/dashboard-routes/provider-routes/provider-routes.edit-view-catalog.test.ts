import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
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
            image: [],
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

const editView = (
  routes: Awaited<ReturnType<typeof createEditViewFixture>>['routes'],
  id: string,
  refreshCatalog = false,
) => routes.request(`/providers/${id}/edit-view${refreshCatalog ? '?refreshCatalog=true' : ''}`);

test('an ordinary edit-view read never touches upstream', async () => {
  const fixture = await createEditViewFixture();
  try {
    const response = await editView(fixture.routes, 'person');

    expect(response.status).toBe(200);
    const body = (await response.json()) as { oauth: { models: string[] } };
    expect(body.oauth.models).toEqual(['model-1']);
    // The whole point of gating on `refreshCatalog`: opening the editor, saving, and every
    // invalidation hit this route, and none of them may provoke an upstream discovery.
    expect(fixture.discoveries()).toBe(0);
    expect(body).not.toHaveProperty('catalogRefreshed');
  } finally {
    fixture.cleanup();
  }
});

test('refreshCatalog rediscovers an unexpired catalog and answers with the new models', async () => {
  const fixture = await createEditViewFixture();
  try {
    const response = await editView(fixture.routes, 'person', true);

    expect(response.status).toBe(200);
    // The read happens after the refresh awaited its own snapshot rebuild, so these are the models the
    // proxy will actually route to.
    expect(await response.json()).toMatchObject({
      catalogRefreshed: true,
      oauth: { models: ['model-1', 'model-2'] },
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

test('refreshCatalog on a non-OAuth Provider is ignored rather than discovering anything', async () => {
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
