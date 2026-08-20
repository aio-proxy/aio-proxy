import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseRuntimeConfig } from '@aio-proxy/core';

import { createServerState } from '#server-test-lifecycle';

import { ConfigReloadRejectedError } from '../../config-store';
import { disabledDashboardAuthentication } from '../../dashboard-auth/test-support';
import type { ServerState } from '../../server-state';
import { createDashboardRoutes } from '../config';

const authoredProvider = {
  kind: 'api',
  protocol: 'openai-response',
  baseURL: '{{env.PROVIDER_ENABLE_BASE_URL}}',
  apiKey: 'sk-preserved',
  headers: { Authorization: 'Bearer {{env.PROVIDER_ENABLE_TOKEN}}' },
  models: ['gpt-test'],
  enabled: true,
  weight: 7,
};

describe('PATCH /providers/:id/enabled', () => {
  let directory: string;
  let configPath: string;
  let state: ServerState;
  let routes: ReturnType<typeof createDashboardRoutes>;

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), 'aio-dashboard-provider-enable-'));
    configPath = join(directory, 'config.json');
    const input = {
      providers: {
        'openai-main': authoredProvider,
        broken: { kind: 'api' },
      },
    };
    writeFileSync(configPath, JSON.stringify(input, null, 2));
    process.env['PROVIDER_ENABLE_BASE_URL'] = 'https://api.example/v1';
    process.env['PROVIDER_ENABLE_TOKEN'] = 'expanded-secret';
    state = await createServerState({ config: parseRuntimeConfig(input), configPath, watchConfig: false });
    routes = createDashboardRoutes(state, disabledDashboardAuthentication);
  });

  afterEach(() => {
    state.close();
    rmSync(directory, { recursive: true, force: true });
    delete process.env['PROVIDER_ENABLE_BASE_URL'];
    delete process.env['PROVIDER_ENABLE_TOKEN'];
  });

  test('changes only enabled and returns the reloaded provider summary', async () => {
    const response = await routes.request('/providers/openai-main/enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ provider: { id: 'openai-main', enabled: false } });
    const onDisk = JSON.parse(readFileSync(configPath, 'utf8')) as {
      providers: Record<string, unknown>;
    };
    expect(onDisk.providers['openai-main']).toEqual({ ...authoredProvider, enabled: false });
    expect(onDisk.providers.broken).toEqual({ kind: 'api' });
  });

  test('rejects an invalid provider row without changing its authored entry', async () => {
    const before = readFileSync(configPath, 'utf8');

    const response = await routes.request('/providers/broken/enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });

    expect(response.status).toBe(404);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  test('returns 404 for a provider ID that is not configured', async () => {
    const response = await routes.request('/providers/oauth-group/enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(404);
  });

  test('rejects a provider that becomes invalid before its queued mutation runs', async () => {
    Object.defineProperty(state.configStore, 'mutateProviders', {
      value: async (mutate: (record: Record<string, unknown>) => Record<string, unknown>) => {
        mutate({ 'openai-main': { kind: 'api' } });
      },
    });

    const response = await routes.request('/providers/openai-main/enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(404);
  });

  test('returns 422 without changing the file when reload rejects the candidate', async () => {
    const before = readFileSync(configPath, 'utf8');
    Object.defineProperty(state.configStore, 'mutateProviders', {
      value: async () => {
        throw new ConfigReloadRejectedError('test rejection');
      },
    });

    const response = await routes.request('/providers/openai-main/enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(422);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });

  test('rejects fields outside the typed enabled-state body', async () => {
    const before = readFileSync(configPath, 'utf8');

    const response = await routes.request('/providers/openai-main/enabled', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false, weight: 0 }),
    });

    expect(response.status).toBe(400);
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});
