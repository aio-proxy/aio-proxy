import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';

import { errorStream, mockModelsDevCatalog, restoreFetch, textStream } from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe('POST /v1/chat/completions', () => {
  test('Given first native provider throws When completion is posted Then next provider is used', async () => {
    const first = {
      id: 'offline',
      kind: 'api',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => {
        throw new Error('connection refused');
      },
    } satisfies ApiProviderInstance;
    const second = {
      id: 'ok',
      kind: 'api',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ fallback: true }),
    } satisfies ApiProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fallback: true });
  });

  test('Given first AI SDK stream fails before its first event When completion streams Then next provider is used', async () => {
    const first = {
      id: 'broken-stream',
      kind: 'ai-sdk',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      invoke: () => errorStream(new Error('upstream exploded')),
    } satisfies AiSdkProviderInstance;
    const second = {
      id: 'ok',
      kind: 'ai-sdk',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      invoke: () =>
        textStream([
          { type: 'text-start', id: 'fallback' },
          { type: 'text-delta', id: 'fallback', text: 'fallback ok' },
          { type: 'text-end', id: 'fallback' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('fallback ok');
  });

  test('Given first provider returns 400 When completion is posted Then no fallback occurs', async () => {
    let secondCalled = false;
    const first = {
      id: 'bad-request',
      kind: 'api',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      passthrough: async () => Response.json({ error: 'bad request' }, { status: 400 }),
    } satisfies ApiProviderInstance;
    const second = {
      id: 'ok',
      kind: 'ai-sdk',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      invoke: () => {
        secondCalled = true;
        return textStream([
          { type: 'text-start', id: 'fallback' },
          { type: 'text-delta', id: 'fallback', text: 'fallback ok' },
          { type: 'text-end', id: 'fallback' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [first, second] });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });

    expect(response.status).toBe(400);
    expect(secondCalled).toBe(false);
  });
});
