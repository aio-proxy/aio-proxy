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
  testCapabilities,
  testCapabilitySignals,
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

  test('Given duplicate models When models are requested Then the highest-weight provider owns each id', async () => {
    // Metadata is keyed by the alias slug each provider exposes. displayName is
    // derived from name !== id, so no separate display map is needed.
    await seedModelsDevCatalog({
      'claude-sonnet-4-6': modelsDevModel('claude-sonnet-4-6', 'Claude Sonnet 4.6', {
        ...testCapabilitySignals,
        limit: { context: 1_000_000, input: 1_000_000, output: 128_000 },
        release_date: '2026-01-15',
      }),
      'gpt-only': modelsDevModel('gpt-only', 'GPT Only', { release_date: '2026-02-30' }),
      shared: modelsDevModel('shared', 'Shared Model'),
    });
    const app = await createServer({
      config: {
        providers: {
          low: {
            kind: 'api',
            weight: 1,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://low.example.com',
            models: ['shared', 'gpt-only'],
          },
          high: {
            kind: 'api',
            weight: 10,
            protocol: ProviderProtocol.Anthropic,
            baseURL: 'https://high.example.com',
            models: ['opaque-claude', 'shared'],
            alias: { 'claude-sonnet-4-6': 'opaque-claude' },
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(await response.json()).toEqual(
      expectedModelList([
        // `high` is tried first (weight 10) and lists its direct models before its aliases, so
        // `shared` leads and the alias slug follows.
        // shared/gpt-only have no catalog limit.input (only context/output), so
        // max_input_tokens is null — the context window is never used as a fallback.
        expectedModel('shared', 'high', 'Shared Model', {
          capabilities: textOnlyCapabilities,
          created: 1_768_435_200,
          createdAt: '2026-01-15T00:00:00.000Z',
          maxTokens: 8_000,
        }),
        expectedModel('claude-sonnet-4-6', 'high', 'Claude Sonnet 4.6', {
          capabilities: testCapabilities,
          created: 1_768_435_200,
          createdAt: '2026-01-15T00:00:00.000Z',
          maxInputTokens: 1_000_000,
          maxTokens: 128_000,
        }),
        expectedModel('gpt-only', 'low', 'GPT Only', {
          capabilities: textOnlyCapabilities,
          created: 0,
          createdAt: '1970-01-01T00:00:00Z',
          maxTokens: 8_000,
        }),
      ]),
    );
  });

  test('Given equal provider weights When models are requested Then configuration order breaks ties', async () => {
    await seedEmptyModelsDevCatalog();
    const app = await createServer({
      config: {
        providers: {
          first: {
            kind: 'api',
            weight: 5,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://first.example.com',
            models: ['shared'],
          },
          second: {
            kind: 'api',
            weight: 5,
            protocol: ProviderProtocol.Anthropic,
            baseURL: 'https://second.example.com',
            models: ['shared'],
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(await response.json()).toEqual(expectedModelList([expectedModel('shared', 'first')]));
  });
});
