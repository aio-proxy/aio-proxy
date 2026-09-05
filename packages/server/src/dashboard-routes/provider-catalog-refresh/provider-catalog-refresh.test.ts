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

async function createCatalogRefreshFixture(options: FixtureOptions = {}) {
  const { fail = false, enabled = true } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-catalog-refresh-'));
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
        // discovery the route triggers can only have come from the forced refresh.
        policy: { kind: 'ttl', ttlMs: 24 * 60 * 60_000 },
        async discover() {
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
    storedModelIds: () => repository.readCatalog('person')?.catalog.language.map(({ id }) => id),
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const refresh = (routes: Awaited<ReturnType<typeof createCatalogRefreshFixture>>['routes'], id: string) =>
  routes.request(`/providers/${id}/catalog/refresh`, { method: 'POST' });

test('a manual refresh rediscovers an unexpired catalog and persists it before acknowledging', async () => {
  const fixture = await createCatalogRefreshFixture();
  try {
    expect(fixture.storedModelIds()).toEqual(['model-1']);

    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(200);
    // The rebuild is already awaited, so the committed list can be answered inline and the client
    // needs no follow-up read.
    expect(await response.json()).toEqual({ models: ['model-1', 'model-2'] });
    expect(fixture.storedModelIds()).toEqual(['model-1', 'model-2']);
  } finally {
    fixture.cleanup();
  }
});

test('a disabled OAuth Provider can still be refreshed manually', async () => {
  const fixture = await createCatalogRefreshFixture({ enabled: false });
  try {
    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(200);
    expect(fixture.storedModelIds()).toEqual(['model-1', 'model-2']);
  } finally {
    fixture.cleanup();
  }
});

test('a non-OAuth Provider and an unknown Provider ID both answer 404', async () => {
  const fixture = await createCatalogRefreshFixture();
  try {
    expect((await refresh(fixture.routes, 'plain')).status).toBe(404);
    expect((await refresh(fixture.routes, 'missing')).status).toBe(404);
  } finally {
    fixture.cleanup();
  }
});

test('a failed discovery answers 502 and leaves the previous catalog stored', async () => {
  const fixture = await createCatalogRefreshFixture({ fail: true });
  try {
    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'CATALOG_UNAVAILABLE' });
    expect(fixture.storedModelIds()).toEqual(['model-1']);
  } finally {
    fixture.cleanup();
  }
});
