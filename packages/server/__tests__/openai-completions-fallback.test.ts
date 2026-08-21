import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance, ApiProviderInstance } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';
import type { TextStreamPart, ToolSet } from 'ai';

import { createServer } from '#server-test-lifecycle';

import {
  createTempHomes,
  mockModelsDevCatalog,
  recorded,
  restoreFetch,
  textStream,
} from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);
const homes = createTempHomes('aio-proxy-openai-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1/chat/completions', () => {
  test('Given first provider returns 429 When completion is posted Then next provider is used', async () => {
    const passthrough = async () => Response.json({ error: 'rate limited' }, { status: 429 });
    const first = {
      id: 'rate-limited',
      kind: 'api',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      endpointTransports: [{ protocol: ProviderProtocol.OpenAICompatible, passthrough }],
      passthrough,
    } satisfies ApiProviderInstance;
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
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }] }),
    });

    const body = await response.json();
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain('fallback ok');
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: 'success',
          attempts: [
            expect.objectContaining({ index: 0, providerId: 'rate-limited', outcome: 'failure' }),
            expect.objectContaining({ index: 1, providerId: 'ok', outcome: 'success' }),
          ],
        }),
      ],
      usages: [expect.objectContaining({ providerId: 'ok', inputTokens: 1, outputTokens: 1 })],
    });
  });

  test('Given stream emits data then errors When completion streams Then request is failure', async () => {
    const dbHome = tempHome();
    const provider = {
      id: 'broken-after-data',
      kind: 'ai-sdk',
      models: ['gpt-5-mini'],
      alias: { 'gpt-5-mini': { model: 'gpt-5-mini', preserve: false } },
      invoke: () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
            controller.error(new Error('stream broke'));
          },
        }),
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'hi' }], stream: true }),
    });
    await response.text();

    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: 'failure', attempts: [expect.objectContaining({ outcome: 'failure' })] }),
      ],
      usages: [],
    });
  });
});
