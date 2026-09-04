import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig } from '@aio-proxy/core';
import { DashboardProvidersResponseSchema } from '@aio-proxy/types';

import { createServerState } from '#server-test-lifecycle';

import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import type { ServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';

const authored = {
  providers: {
    alpha: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://alpha.example.test/v1',
      models: ['gpt-test'],
      priority: 20,
      weight: 7,
      headers: { 'x-tenant': 'alpha' },
    },
    beta: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://beta.example.test/v1',
      models: ['gpt-test'],
      priority: 10,
      weight: 3,
    },
  },
  router: {
    models: {
      'gpt-test': { providers: { alpha: { weight: 9 } } },
    },
  },
};

describe('PUT /providers/routing', () => {
  let directory: string;
  let configPath: string;
  let state: ServerState;
  let routes: ReturnType<typeof createDashboardRoutes>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-provider-routing-'));
    configPath = join(directory, 'config.json');
    writeFileSync(configPath, JSON.stringify(authored, null, 2));
    state = await createServerState({ config: parseRuntimeConfig(authored), configPath, watchConfig: false });
    routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  });

  afterEach(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  });

  test('GET exposes a routing revision and PUT atomically updates only Provider routing values', async () => {
    const beforeResponse = await routes.request('/providers');
    const before = DashboardProvidersResponseSchema.parse(await beforeResponse.json());

    expect(beforeResponse.status).toBe(200);
    expect(before.routingRevision).not.toBe('');

    const response = await routes.request('/providers/routing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: before.routingRevision,
        providers: {
          alpha: { priority: 10, weight: 2500 },
          beta: { priority: 10, weight: 7500 },
        },
      }),
    });
    const payload = DashboardProvidersResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(payload.routingRevision).not.toBe(before.routingRevision);
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as typeof authored;
    expect(onDisk.providers.alpha).toEqual({
      ...authored.providers.alpha,
      priority: 10,
      weight: 2500,
    });
    expect(onDisk.providers.beta).toEqual({
      ...authored.providers.beta,
      priority: 10,
      weight: 7500,
    });
    expect(onDisk.router).toEqual(authored.router);
  });

  test('rejects stale revisions and changed Provider sets without modifying the config file', async () => {
    const beforeText = readFileSync(configPath, 'utf8');
    const before = DashboardProvidersResponseSchema.parse(await (await routes.request('/providers')).json());

    const stale = await routes.request('/providers/routing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: `${before.routingRevision}-stale`,
        providers: {
          alpha: { priority: 10, weight: 5000 },
          beta: { priority: 10, weight: 5000 },
        },
      }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'stale_revision' });
    expect(readFileSync(configPath, 'utf8')).toBe(beforeText);

    const changedSet = await routes.request('/providers/routing', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: before.routingRevision,
        providers: { alpha: { priority: 10, weight: 10000 } },
      }),
    });
    expect(changedSet.status).toBe(409);
    expect(await changedSet.json()).toEqual({ error: 'provider_set_changed' });
    expect(readFileSync(configPath, 'utf8')).toBe(beforeText);
  });
});
