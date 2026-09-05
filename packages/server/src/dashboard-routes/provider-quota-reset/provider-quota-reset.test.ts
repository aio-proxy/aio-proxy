import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, type OAuthQuotaSnapshot, zod } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import { createDashboardRoutes } from '../config';

type FixtureOptions = {
  /** Whether the adapter exposes `quota.reset` at all. */
  readonly resettable?: boolean;
  readonly credits?: number;
  readonly fail?: boolean;
  /** Stored account options that no longer satisfy the plugin schema: a transient preparation failure. */
  readonly brokenOptions?: boolean;
};

async function createQuotaResetFixture(options: FixtureOptions = {}) {
  const { resettable = true, credits = 1, fail = false, brokenOptions = false } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-quota-reset-'));
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
  let resetCalls = 0;
  let reads = 0;
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: 'default',
      displayName: 'Example OAuth',
      account: {
        options: {
          schema: brokenOptions ? zod.object({ tenant: zod.number() }) : zod.object({ tenant: zod.string() }),
          form: [],
        },
      },
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
        read: async (): Promise<OAuthQuotaSnapshot> => {
          reads += 1;
          // Redemption spends the credit, so a post-reset read must not still offer one: the route's
          // cache invalidation is only observable through a second read reporting the new inventory.
          const remaining = Math.max(credits - resetCalls, 0);
          return { items: [], resetCredits: { availableCount: remaining } };
        },
        ...(resettable
          ? {
              reset: async () => {
                if (fail) throw new Error('upstream rejected');
                resetCalls += 1;
              },
            }
          : {}),
      },
      async createRuntime() {
        throw new Error('not used');
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse({
      plugins: ['@example/oauth'],
      providers: {
        person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', options: { tenant: 'work' } },
        plain: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://example.com' },
      },
    }),
    pluginRepository: repository,
    watchConfig: false,
    // These fixtures exercise failure paths on purpose; plugin-log redaction has its own test, and
    // letting the sink write here only pollutes the run.
    pluginLogger: () => {},
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    routes,
    resetCalls: () => resetCalls,
    reads: () => reads,
    readQuota: (id: string) =>
      routes.request(`/providers/${id}/quota`, {
        method: 'QUERY',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      }),
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const reset = (routes: Awaited<ReturnType<typeof createQuotaResetFixture>>['routes'], id: string) =>
  routes.request(`/providers/${id}/quota/reset`, { method: 'POST' });

test('a redemption acknowledges and drops the snapshot it was authorized from', async () => {
  const fixture = await createQuotaResetFixture();
  try {
    // Seeds the cache the way the dialog does, so the invalidation has something to drop. Without it
    // the post-reset read would go upstream regardless and prove nothing.
    expect((await fixture.readQuota('person')).status).toBe(200);
    const seeded = fixture.reads();

    const response = await reset(fixture.routes, 'person');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(fixture.resetCalls()).toBe(1);

    // Inside the cache's five-minute cooldown: without the route's invalidation this read would serve
    // the pre-reset snapshot and keep showing a credit that no longer exists.
    const after = await fixture.readQuota('person');
    expect(await after.json()).toMatchObject({ snapshot: { resetCredits: { availableCount: 0 } } });
    expect(fixture.reads()).toBeGreaterThan(seeded + 1);
  } finally {
    fixture.cleanup();
  }
});

test('a plugin whose quota capability has no reset answers 404', async () => {
  const fixture = await createQuotaResetFixture({ resettable: false });
  try {
    const response = await reset(fixture.routes, 'person');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'OAUTH_QUOTA_RESET_UNSUPPORTED' });
  } finally {
    fixture.cleanup();
  }
});

test('a non-OAuth Provider and an unknown Provider ID both answer 404', async () => {
  const fixture = await createQuotaResetFixture();
  try {
    expect((await reset(fixture.routes, 'plain')).status).toBe(404);
    expect((await reset(fixture.routes, 'missing')).status).toBe(404);
    expect(fixture.resetCalls()).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

// 409, not 502: the inventory the client rendered its button from is spent, which is not an upstream
// failure and must not read as one.
test('an exhausted inventory answers 409 without redeeming', async () => {
  const fixture = await createQuotaResetFixture({ credits: 0 });
  try {
    const response = await reset(fixture.routes, 'person');

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'OAUTH_QUOTA_RESET_UNAVAILABLE' });
    expect(fixture.resetCalls()).toBe(0);
  } finally {
    fixture.cleanup();
  }
});

test('a transient account preparation failure answers 502 without naming the cause', async () => {
  const fixture = await createQuotaResetFixture({ brokenOptions: true });
  try {
    const response = await reset(fixture.routes, 'person');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAUTH_QUOTA_CAPABILITY_UNAVAILABLE' });
  } finally {
    fixture.cleanup();
  }
});

test('a failed upstream redemption answers 502', async () => {
  const fixture = await createQuotaResetFixture({ fail: true });
  try {
    const response = await reset(fixture.routes, 'person');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAUTH_QUOTA_RESET_FAILED' });
  } finally {
    fixture.cleanup();
  }
});
