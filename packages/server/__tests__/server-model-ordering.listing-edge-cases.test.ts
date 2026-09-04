import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderProtocol } from '@aio-proxy/types';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import { loopbackServer } from '../src/dashboard-auth/test-support';
import {
  clearModelsDevCatalog,
  expectedModel,
  expectedModelList,
  seedEmptyModelsDevCatalog,
} from './server.test-support';

describe('server routes', () => {
  let dir: string;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-server-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearModelsDevCatalog();
  });

  test('Given no catalog metadata When models are requested Then ids remain valid display names', async () => {
    // An empty catalog yields no metadata, so the display name falls back to the
    // model id, matching the old models.dev-failure behavior.
    await seedEmptyModelsDevCatalog();
    const app = await createServer({
      config: {
        providers: {
          api: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://api.example.com',
            models: ['plain-model'],
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(await response.json()).toEqual(expectedModelList([expectedModel('plain-model', 'api')]));
  });

  test('Given disabled provider When models and dashboard are requested Then provider is not routed', async () => {
    // Given
    const app = await createServer({
      config: {
        providers: {
          openai: {
            kind: 'api',
            enabled: false,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://api.example.com',
            models: ['gpt-disabled', 'gpt-untouched'],
            alias: { disabled: { model: 'gpt-disabled', preserve: false } },
          },
        },
      },
    });

    // When
    const models = await app.request('/v1/models');
    const providers = await app.request('/dashboard/api/providers', undefined, loopbackServer);

    // Then
    expect(await models.json()).toEqual(expectedModelList([]));
    expect(await providers.json()).toEqual({
      providers: [
        {
          id: 'openai',
          kind: 'api',
          enabled: false,
          passthrough: true,
          last_status: 'unknown',
          last_latency: null,
          priority: 0,
          weight: 1,
          protocols: [ProviderProtocol.OpenAICompatible],
          hasQuota: false,
          canRefreshCredential: false,
          clientModels: ['gpt-untouched', 'disabled'],
          hasApiKey: false,
          state: { status: 'ready' },
        },
      ],
    });
  });
});
