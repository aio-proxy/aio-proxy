import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { digestProviderEntry, parseRuntimeConfig } from '@aio-proxy/core';
import { DashboardRoutingModelsResponseSchema, DashboardRoutingMutationErrorCodeSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import type { ServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';

const authored = {
  providers: {
    off: {
      kind: 'api',
      enabled: false,
      protocol: 'openai-compatible',
      baseURL: 'https://off.example.test/v1',
      models: ['openai/gpt-5'],
      weight: 1.6,
    },
    on: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://on.example.test/v1',
      models: ['openai/gpt-5'],
      priority: 10,
      weight: 2,
    },
  },
  router: {
    models: {
      'openai/gpt-5': {
        providers: {
          on: { priority: 20 },
          ghost: { weight: 9 },
        },
      },
    },
  },
};

type Routes = ReturnType<typeof createDashboardRoutes>;

async function withRoutingFixture(
  run: (fixture: {
    readonly configPath: string;
    readonly routes: Routes;
    readonly state: ServerState;
  }) => Promise<void>,
  options: { readonly configPath?: boolean } = {},
): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-routing-'));
  const configPath = join(directory, 'config.json');
  writeFileSync(configPath, JSON.stringify(authored, null, 2));
  const state = await createServerState({
    config: parseRuntimeConfig(authored),
    dbHome: directory,
    ...(options.configPath === false ? {} : { configPath }),
    watchConfig: false,
  });
  try {
    await run({ configPath, routes: createDashboardRoutes(state, disabledDashboardAuthentication), state });
  } finally {
    state.close();
    rmSync(directory, { force: true, recursive: true });
  }
}

test('GET /routing/models includes inactive Providers and hides unknown entries', async () => {
  await withRoutingFixture(async ({ routes }) => {
    const response = await routes.request('/routing/models');
    const body = DashboardRoutingModelsResponseSchema.parse(await response.json());
    const model = body.models.find((entry) => entry.modelId === 'openai/gpt-5');

    expect(response.status).toBe(200);
    expect(body.writable).toBe(true);
    expect(model?.baselineProviderIds).toEqual(['off', 'on']);
    expect(model?.providers.map((entry) => entry.id)).toEqual(['off', 'on']);
    expect(model?.providers[0]).toMatchObject({
      id: 'off',
      enabled: false,
      defaults: { weight: { authored: 1.6, effective: 2, wasNormalized: true } },
      effective: { eligible: false, share: null },
    });
    expect(model?.providers[1]).toMatchObject({
      id: 'on',
      override: { priority: { authored: 20, effective: 20, wasNormalized: false } },
      effective: { eligible: true, priority: 20, prioritySource: 'model' },
    });
  });
});

test('GET /routing/models is read-only when the config path is missing', async () => {
  await withRoutingFixture(
    async ({ routes }) => {
      const response = await routes.request('/routing/models');
      const body = DashboardRoutingModelsResponseSchema.parse(await response.json());
      expect(response.status).toBe(200);
      expect(body.writable).toBe(false);
      expect(body.models.map((entry) => entry.modelId)).toContain('openai/gpt-5');
    },
    { configPath: false },
  );
});

test('PUT /routing/models replaces the baseline and preserves unknown raw entries', async () => {
  await withRoutingFixture(async ({ configPath, routes }) => {
    const listed = DashboardRoutingModelsResponseSchema.parse(await (await routes.request('/routing/models')).json());
    const current = listed.models.find((entry) => entry.modelId === 'openai/gpt-5');
    const response = await routes.request('/routing/models', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'openai/gpt-5',
        revision: current?.revision,
        baselineProviderIds: current?.baselineProviderIds,
        providers: { on: { priority: 40, weight: 4 } },
      }),
    });
    const body = DashboardRoutingModelsResponseSchema.parse(await response.json());
    const disk = JSON.parse(readFileSync(configPath, 'utf8')) as typeof authored;

    expect(response.status).toBe(200);
    expect(body.models.find((entry) => entry.modelId === 'openai/gpt-5')?.providers[1]).toMatchObject({
      id: 'on',
      override: {
        priority: { authored: 40, effective: 40, wasNormalized: false },
        weight: { authored: 4, effective: 4, wasNormalized: false },
      },
    });
    expect(disk.router.models['openai/gpt-5'].providers).toEqual({
      on: { priority: 40, weight: 4 },
      ghost: { weight: 9 },
    });
  });
});

test('PUT /routing/models returns typed config, revision, and validation errors', async () => {
  await withRoutingFixture(async ({ routes }) => {
    const stale = await routes.request('/routing/models', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'openai/gpt-5',
        revision: digestProviderEntry({ providers: { on: { priority: 1 } } }),
        baselineProviderIds: ['off', 'on'],
        providers: { on: { priority: 40 } },
      }),
    });
    const invalid = await routes.request('/routing/models', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'openai/gpt-5',
        revision: 'rev',
        baselineProviderIds: ['on', 'on'],
        providers: { on: { priority: 1.5 } },
      }),
    });

    expect(stale.status).toBe(409);
    expect(DashboardRoutingMutationErrorCodeSchema.parse(((await stale.json()) as { error: string }).error)).toBe(
      'stale_revision',
    );
    expect(invalid.status).toBe(400);
    expect(DashboardRoutingMutationErrorCodeSchema.parse(((await invalid.json()) as { error: string }).error)).toBe(
      'validation_failed',
    );
  });

  await withRoutingFixture(
    async ({ routes }) => {
      const response = await routes.request('/routing/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          modelId: 'openai/gpt-5',
          revision: digestProviderEntry(null),
          baselineProviderIds: ['on'],
          providers: { on: { priority: 40 } },
        }),
      });
      expect(response.status).toBe(409);
      expect(DashboardRoutingMutationErrorCodeSchema.parse(((await response.json()) as { error: string }).error)).toBe(
        'config_unavailable',
      );
    },
    { configPath: false },
  );
});

test('GET /providers/:id/edit-view returns authored and effective routing numbers', async () => {
  await withRoutingFixture(async ({ routes }) => {
    const response = await routes.request('/providers/off/edit-view');
    const body = (await response.json()) as {
      routing?: { priority: unknown; weight: unknown };
    };
    expect(response.status).toBe(200);
    expect(body.routing).toEqual({
      priority: { effective: 0, wasNormalized: false },
      weight: { authored: 1.6, effective: 2, wasNormalized: true },
    });
  });
});
