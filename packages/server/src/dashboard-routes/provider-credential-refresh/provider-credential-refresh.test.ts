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
  readonly refreshable?: boolean;
  readonly fail?: boolean;
  /** Stored account options that no longer satisfy the plugin schema: a transient preparation failure. */
  readonly brokenOptions?: boolean;
};

async function createRefreshFixture(options: FixtureOptions = {}) {
  const { refreshable = true, fail = false, brokenOptions = false } = options;
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-credential-refresh-'));
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
      ...(refreshable
        ? {
            refreshCredential: async () => {
              if (fail) throw new Error('upstream rejected');
              return {
                value: { accessToken: 'rotated' },
                metadata: { accountLabel: 'rotated@example.com' },
              };
            },
          }
        : {}),
      async createRuntime() {
        // Never invoked: nothing here routes a generation request. Returning a stub instead of
        // throwing keeps snapshot builds from logging a runtime-creation failure on every fixture.
        return { provider: { specificationVersion: 'v4' } } as never;
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
    // These fixtures exercise failure paths on purpose; the plugin log sink is Task 3's contract,
    // covered by its own redaction test, and letting it write here only pollutes the run.
    pluginLogger: () => {},
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    routes,
    repository,
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const refresh = (routes: Awaited<ReturnType<typeof createRefreshFixture>>['routes'], id: string) =>
  routes.request(`/providers/${id}/credential/refresh`, { method: 'POST' });

test('a manual refresh persists the rotated credential and answers with the provider summary', async () => {
  const fixture = await createRefreshFixture();
  try {
    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: { id: 'person', canRefreshCredential: true } });
    expect(fixture.repository.readAccount('person')?.credential).toEqual({ accessToken: 'rotated' });
    expect(fixture.repository.readAccount('person')?.label).toBe('rotated@example.com');
  } finally {
    fixture.cleanup();
  }
});

test('a plugin with no refresh capability answers 404', async () => {
  const fixture = await createRefreshFixture({ refreshable: false });
  try {
    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'OAUTH_ACCOUNT_UNAVAILABLE' });
  } finally {
    fixture.cleanup();
  }
});

test('a non-OAuth Provider and an unknown Provider ID both answer 404', async () => {
  const fixture = await createRefreshFixture();
  try {
    expect((await refresh(fixture.routes, 'plain')).status).toBe(404);
    expect((await refresh(fixture.routes, 'missing')).status).toBe(404);
  } finally {
    fixture.cleanup();
  }
});

test('a transient account preparation failure answers 502 without naming the cause', async () => {
  const fixture = await createRefreshFixture({ brokenOptions: true });
  try {
    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(502);
    // The account exists and its plugin does expose the capability; only its stored options failed to
    // parse. The body must stay as opaque as the error type so a caller cannot probe which step broke.
    expect(await response.json()).toEqual({ error: 'OAUTH_ACCOUNT_UNAVAILABLE' });
  } finally {
    fixture.cleanup();
  }
});

test('a failed upstream exchange answers 502', async () => {
  const fixture = await createRefreshFixture({ fail: true });
  try {
    const response = await refresh(fixture.routes, 'person');

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: 'OAUTH_CREDENTIAL_REFRESH_FAILED' });
    expect(fixture.repository.readAccount('person')?.credential).toEqual({ accessToken: 'stored-credential' });
  } finally {
    fixture.cleanup();
  }
});
