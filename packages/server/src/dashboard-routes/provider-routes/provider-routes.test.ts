import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod, type OAuthQuotaSnapshot } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

const SNAPSHOT: OAuthQuotaSnapshot = {
  items: [{ id: 'weekly', displayName: 'Weekly', remainingRatio: 0.5 }],
  plan: 'Allegro',
};

async function createQuotaFixture(options: { read?: () => Promise<OAuthQuotaSnapshot>; breakRuntime?: boolean } = {}) {
  const { read, breakRuntime = false } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-provider-quota-'));
  const input = {
    plugins: ['@example/oauth'],
    providers: {
      person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', options: { tenant: 'work' } },
      plain: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.com' },
    },
  };
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
  let reads = 0;
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
        policy: { kind: 'static' },
        async discover() {
          throw new Error('not used');
        },
      },
      quota: {
        read: async () => {
          reads += 1;
          return read === undefined ? SNAPSHOT : await read();
        },
      },
      async createRuntime() {
        if (breakRuntime) throw new Error('runtime is broken');
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
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    pluginRepository: repository,
    watchConfig: false,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    routes,
    reads: () => reads,
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const quota = (routes: Awaited<ReturnType<typeof createQuotaFixture>>['routes'], id: string, body: unknown = {}) =>
  routes.request(`/providers/${id}/quota`, {
    method: 'QUERY',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test('serves a quota snapshot once and reuses it until an explicit refresh', async () => {
  const fixture = await createQuotaFixture();
  try {
    const response = await quota(fixture.routes, 'person');
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.snapshot).toEqual(SNAPSHOT);
    expect(payload.stale).toBe(false);
    expect(payload.sampledAt).toBeGreaterThan(0);

    await quota(fixture.routes, 'person');
    expect(fixture.reads()).toBe(1);

    await quota(fixture.routes, 'person', { refresh: true });
    expect(fixture.reads()).toBe(2);
  } finally {
    fixture.cleanup();
  }
});

test('reports the quota capability on the provider summary', async () => {
  const fixture = await createQuotaFixture();
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    expect(providers.find((provider: { id: string }) => provider.id === 'person')?.hasQuota).toBe(true);
    expect(providers.find((provider: { id: string }) => provider.id === 'plain')?.hasQuota).toBe(false);
  } finally {
    fixture.cleanup();
  }
});

test('keeps reporting the quota capability when the provider runtime is unavailable', async () => {
  const fixture = await createQuotaFixture({ breakRuntime: true });
  try {
    const { providers } = await (await fixture.routes.request('/providers')).json();
    const person = providers.find((provider: { id: string }) => provider.id === 'person');
    expect(person?.state.status).toBe('unavailable');
    expect(person?.hasQuota).toBe(true);
  } finally {
    fixture.cleanup();
  }
});

test('answers 404 for an unknown provider and for one without a quota capability', async () => {
  const fixture = await createQuotaFixture();
  try {
    expect((await quota(fixture.routes, 'missing')).status).toBe(404);
    expect((await quota(fixture.routes, 'plain')).status).toBe(404);
  } finally {
    fixture.cleanup();
  }
});

test('reports an unreadable quota as 502 rather than an empty snapshot', async () => {
  const fixture = await createQuotaFixture({
    read: async () => {
      throw new Error('upstream down');
    },
  });
  try {
    const response = await quota(fixture.routes, 'person');
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAuth quota read failed' });
  } finally {
    fixture.cleanup();
  }
});
