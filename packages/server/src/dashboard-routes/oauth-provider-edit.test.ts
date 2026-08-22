import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPluginRepository } from '@aio-proxy/core';
import { openDb } from '@aio-proxy/core/db';
import { definePlugin, zod, type DefaultAliasSuggestion, type OAuthAdapter } from '@aio-proxy/plugin-sdk';
import { ConfigSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../dashboard-auth/test-support';
import { createDashboardRoutes } from './config';

async function createOAuthEditFixture(defaultAliases?: OAuthAdapter['catalog']['defaultAliases']) {
  const dir = mkdtempSync(join(tmpdir(), 'aio-dashboard-oauth-edit-'));
  const configPath = join(dir, 'config.json');
  const input = {
    plugins: ['@example/oauth'],
    providers: {
      person: {
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: 'default',
        name: 'Old name',
        enabled: true,
        weight: 1,
        proxy: 'https://old-proxy.example:8443',
        options: { tenant: 'work' },
        alias: { old: { model: 'model-1' } },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(input));
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
      secrets: { token: 'stored-secret' },
      credential: { accessToken: 'stored-credential' },
      label: 'person@example.com',
      catalog: {
        kind: 'replace',
        value: {
          refreshedAt: Date.now(),
          catalog: {
            language: [{ id: 'model-1' }, { id: 'model-2' }],
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
          schema: zod.object({ tenant: zod.string(), token: zod.string() }),
          form: [
            { type: 'text', key: 'tenant', label: 'Tenant' },
            { type: 'secret', key: 'token', label: 'Token' },
          ],
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
        ...(defaultAliases === undefined ? {} : { defaultAliases }),
      },
      async createRuntime() {
        throw new Error('not used');
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    configPath,
    pluginRepository: repository,
    watchConfig: false,
    builtIns: [{ packageName: '@example/oauth', version: '1.0.0', descriptor }],
  });
  const routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  return {
    configPath,
    routes,
    cleanup: () => {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('OAuth edit-view returns the real proxy but never account secrets, and common edits preserve account identity and options', async () => {
  const { configPath, routes, cleanup } = await createOAuthEditFixture();

  try {
    const editResponse = await routes.request('/providers/person/edit-view');
    expect(editResponse.status).toBe(200);
    const edit = await editResponse.json();
    expect(edit).toMatchObject({
      provider: {
        id: 'person',
        kind: 'oauth',
        plugin: '@example/oauth',
        capability: 'default',
        proxy: 'https://old-proxy.example:8443',
      },
      oauth: {
        accountLabel: 'person@example.com',
        publicValues: { tenant: 'work' },
        models: ['model-1', 'model-2'],
        form: [
          { type: 'text', key: 'tenant', label: 'Tenant' },
          { type: 'secret', key: 'token', label: 'Token', configured: true },
        ],
      },
    });
    expect(JSON.stringify(edit)).not.toMatch(/stored-secret|stored-credential/u);

    const update = await routes.request('/providers/person', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'oauth',
        id: 'person',
        name: 'Personal',
        enabled: false,
        weight: 4,
        alias: { chat: { model: 'model-2' } },
      }),
    });
    expect(update.status).toBe(200);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Record<string, unknown> };
    expect(onDisk.providers.person).toEqual({
      kind: 'oauth',
      plugin: '@example/oauth',
      capability: 'default',
      name: 'Personal',
      enabled: false,
      weight: 4,
      proxy: 'https://old-proxy.example:8443',
      options: { tenant: 'work' },
      alias: { chat: { model: 'model-2', preserve: false } },
    });
  } finally {
    cleanup();
  }
});

test('OAuth provider updates persist every proxy override state and edit-view returns the current one', async () => {
  const { configPath, routes, cleanup } = await createOAuthEditFixture();
  const update = async (proxy: null | false | string) =>
    routes.request('/providers/person', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'oauth', id: 'person', enabled: true, proxy }),
    });
  const providerOnDisk = () =>
    (JSON.parse(readFileSync(configPath, 'utf8')) as { providers: Record<string, Record<string, unknown>> }).providers[
      'person'
    ];

  try {
    expect((await update(null)).status).toBe(200);
    expect(providerOnDisk()).not.toHaveProperty('proxy');

    expect((await update(false)).status).toBe(200);
    expect(providerOnDisk()).toMatchObject({ proxy: false });

    expect((await update('http://new-proxy.example:8080')).status).toBe(200);
    expect(providerOnDisk()).toMatchObject({ proxy: 'http://new-proxy.example:8080' });

    const edit = await (await routes.request('/providers/person/edit-view')).json();
    expect(edit).toMatchObject({ provider: { proxy: 'http://new-proxy.example:8080' } });
  } finally {
    cleanup();
  }
});

// Filtered per entry, not collectively: one unroutable target and one malformed config must not cost
// the user the suggestion beside them that this catalog can actually serve. `bogus` is the entry the
// per-entry parse exists for — its target is routable, so nothing else stops it, and unparsed it
// would reach the response schema and fail the whole edit-view with a 500.
test('edit-view offers only the plugin default aliases this catalog can route', async () => {
  const { routes, cleanup } = await createOAuthEditFixture(() => ({
    chat: { model: 'model-1' },
    gone: { model: 'not-in-catalog' },
    // A plugin is third-party JavaScript; its declared type does not stop it shipping these.
    broken: { model: 42 } as unknown as DefaultAliasSuggestion,
    bogus: { model: 'model-1', preserve: 'yes' } as unknown as DefaultAliasSuggestion,
  }));

  try {
    const response = await routes.request('/providers/person/edit-view');
    expect(response.status).toBe(200);
    const edit = (await response.json()) as { oauth: { pluginAliases?: unknown } };
    expect(edit.oauth.pluginAliases).toEqual({ chat: { model: 'model-1', preserve: false } });
  } finally {
    cleanup();
  }
});

// Suggestions are a convenience. A plugin that throws while producing them must cost the user the
// suggestions only — this runs inside the edit-view, so propagating would make the page unopenable.
test('a throwing defaultAliases costs the suggestions, not the editor page', async () => {
  const { routes, cleanup } = await createOAuthEditFixture(() => {
    throw new Error('plugin exploded');
  });

  try {
    const response = await routes.request('/providers/person/edit-view');
    expect(response.status).toBe(200);
    const edit = (await response.json()) as { oauth: Record<string, unknown> };
    expect(edit.oauth).not.toHaveProperty('pluginAliases');
  } finally {
    cleanup();
  }
});
