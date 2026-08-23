import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderProtocol } from '@aio-proxy/types';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import {
  clearModelsDevCatalog,
  config,
  expectedModel,
  expectedModelList,
  seedEmptyModelsDevCatalog,
} from './server.test-support';

describe('server routes', () => {
  let dir: string;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'aio-proxy-server-'));
    await seedEmptyModelsDevCatalog();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearModelsDevCatalog();
  });

  test('GET /health returns ok status and version when requested', async () => {
    // Given
    const app = await createServer({ config });

    // When
    const response = await app.request('/health');
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: 'ok' });
    expect(typeof body.uptime).toBe('number');
    expect(typeof body.version).toBe('string');
  });

  test('Given configured providers When OpenAI models are requested Then model list is returned', async () => {
    // Given
    const app = await createServer({ config });

    // When
    const response = await app.request('/v1/models');
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual(
      expectedModelList([
        expectedModel('gpt-alias', 'openai-compatible'),
        expectedModel('gpt-test', 'openai-compatible'),
        expectedModel('compatible', 'compatible'),
        expectedModel('compatible-test', 'compatible'),
      ]),
    );
  });

  test('Given API and AI SDK providers with models only When models are requested Then every model is listed', async () => {
    const app = await createServer({
      config: {
        providers: {
          api: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://api.example.com/v1',
            models: ['api-model'],
          },
          sdk: {
            kind: 'ai-sdk',
            packageName: '@ai-sdk/openai-compatible',
            options: { baseURL: 'https://sdk.example.com/v1', name: 'sdk' },
            models: ['sdk-model'],
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expectedModelList([expectedModel('api-model', 'api'), expectedModel('sdk-model', 'sdk')]),
    );
  });
});
