import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createBaseServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';

import {
  clearModelsDevCatalog,
  expectedModel,
  expectedModelList,
  modelsDevModel,
  seedEmptyModelsDevCatalog,
  seedModelsDevCatalog,
  textOnlyCapabilities,
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

  test('Given added Anthropic aliases When models are requested Then upstream targets are hidden', async () => {
    await seedEmptyModelsDevCatalog();
    const app = await createServer({
      config: {
        providers: {
          'anthropic-aliases': {
            kind: 'api',
            protocol: ProviderProtocol.Anthropic,
            baseURL: 'https://anthropic.example.com',
            models: ['upstream-opus-48', 'upstream-opus-46', 'upstream-sonnet-46'],
            alias: {
              'claude-opus-4-8': 'upstream-opus-48',
              'claude-opus-4-6': 'upstream-opus-46',
              'claude-sonnet-4-6': 'upstream-sonnet-46',
            },
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expectedModelList([
        expectedModel('claude-opus-4-8', 'anthropic-aliases'),
        expectedModel('claude-opus-4-6', 'anthropic-aliases'),
        expectedModel('claude-sonnet-4-6', 'anthropic-aliases'),
      ]),
    );
  });

  test('Given alias metadata without a name When models are requested Then the alias slug is used', async () => {
    // Metadata is read from the alias slug's own entry. name === id, so the
    // alias carries no human-readable name and the slug is used as the display
    // name; the upstream modelId's own entry is never consulted.
    await seedModelsDevCatalog({
      'friendly-alias': modelsDevModel('friendly-alias', 'friendly-alias', {
        limit: { context: 128_000, input: 100, output: 10 },
      }),
    });
    const app = await createServer({
      config: {
        providers: {
          api: {
            kind: 'api',
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://api.example.com/v1',
            models: ['upstream-model'],
            alias: { 'friendly-alias': 'upstream-model' },
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(await response.json()).toEqual(
      expectedModelList([
        expectedModel('friendly-alias', 'api', 'friendly-alias', {
          capabilities: textOnlyCapabilities,
          created: 1_768_435_200,
          createdAt: '2026-01-15T00:00:00.000Z',
          maxInputTokens: 100,
          maxTokens: 10,
        }),
      ]),
    );
  });
});
