import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Router } from '@aio-proxy/core';
import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createServer as createBaseServer } from '#server-test-lifecycle';

import type { RuntimeProviderInstance } from '../src/runtime';
import { textStream } from './openai-completions.test-support';
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

  test('Given duplicate models When models are requested Then priority beats weight for catalog ownership', async () => {
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
            priority: 0,
            weight: 100,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://low.example.com',
            models: ['shared', 'gpt-only'],
          },
          high: {
            kind: 'api',
            priority: 20,
            weight: 1,
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
        expectedModel('shared', 'high', 'Shared Model', {
          capabilities: textOnlyCapabilities,
          created: 1_768_435_200,
          createdAt: '2026-01-15T00:00:00.000Z',
          maxTokens: 8_000,
        }),
        expectedModel('gpt-only', 'low', 'GPT Only', {
          capabilities: textOnlyCapabilities,
          created: 0,
          createdAt: '1970-01-01T00:00:00Z',
          maxTokens: 8_000,
        }),
        expectedModel('claude-sonnet-4-6', 'high', 'Claude Sonnet 4.6', {
          capabilities: testCapabilities,
          created: 1_768_435_200,
          createdAt: '2026-01-15T00:00:00.000Z',
          maxInputTokens: 1_000_000,
          maxTokens: 128_000,
        }),
      ]),
    );
  });

  test('Given equal priorities When models are requested Then higher weight owns the id', async () => {
    await seedEmptyModelsDevCatalog();
    const app = await createServer({
      config: {
        providers: {
          light: {
            kind: 'api',
            priority: 10,
            weight: 1,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://light.example.com',
            models: ['shared'],
          },
          heavy: {
            kind: 'api',
            priority: 10,
            weight: 5,
            protocol: ProviderProtocol.Anthropic,
            baseURL: 'https://heavy.example.com',
            models: ['shared'],
          },
        },
      },
    });

    const response = await app.request('/v1/models');

    expect(await response.json()).toEqual(expectedModelList([expectedModel('shared', 'heavy')]));
  });

  test('Given equal provider weights When models are requested Then configuration order breaks ties', async () => {
    await seedEmptyModelsDevCatalog();
    const app = await createServer({
      config: {
        providers: {
          first: {
            kind: 'api',
            priority: 10,
            weight: 5,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: 'https://first.example.com',
            models: ['shared'],
          },
          second: {
            kind: 'api',
            priority: 10,
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

  test('Given catalog ranking When a request is drawn randomly Then owned_by is not inferred from request order', async () => {
    await seedEmptyModelsDevCatalog();
    const attempts: string[] = [];
    const invokeProvider = (id: string, weight: number): RuntimeProviderInstance =>
      ({
        id,
        kind: ProviderKind.AiSdk,
        enabled: true,
        priority: 10,
        weight,
        models: ['shared'],
        alias: { shared: { model: 'shared', preserve: false } },
        model: {
          invoke: () => {
            attempts.push(id);
            return textStream([
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', text: id },
              { type: 'text-end', id: 't' },
              {
                type: 'finish',
                finishReason: 'stop',
                rawFinishReason: 'stop',
                totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ]);
          },
        },
      }) as RuntimeProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [invokeProvider('light', 1), invokeProvider('heavy', 10)],
      __test: {
        createRouter: (providers, routerConfig) =>
          new Router(providers, { models: routerConfig.models, random: () => 0 }),
      },
    });

    const listing = await app.request('/v1/models');
    expect(await listing.json()).toEqual(expectedModelList([expectedModel('shared', 'heavy')]));

    const completion = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'shared', messages: [{ role: 'user', content: 'hi' }] }),
    });
    expect(completion.status).toBe(200);
    expect(attempts[0]).toBe('light');
  });
});
