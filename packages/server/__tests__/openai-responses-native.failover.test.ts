import { afterEach, describe, expect, test } from 'bun:test';

import { AiSdkProviderError, type ApiProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';
import type { TextStreamPart, ToolSet } from 'ai';

import {
  AbortStreamError,
  aiSdkProvider,
  createTempHomes,
  recorded,
  responsesRequest,
} from './openai-responses.test-support';

const homes = createTempHomes('aio-proxy-responses-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('OpenAI Responses routes', () => {
  test('Given first native provider throws When POST is valid Then next provider is used', async () => {
    const first = {
      id: 'offline',
      kind: 'api',
      models: ['gpt-4.1-mini'],
      alias: { 'gpt-4.1-mini': { model: 'gpt-4.1-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      passthrough: async () => {
        throw new Error('connection refused');
      },
    } satisfies ApiProviderInstance;
    const second = {
      id: 'ok',
      kind: 'api',
      models: ['gpt-4.1-mini'],
      alias: { 'gpt-4.1-mini': { model: 'gpt-4.1-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      passthrough: async () => Response.json({ fallback: true }),
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [first, second] });

    const response = await app.request('/v1/responses', {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fallback: true });
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          attempts: [
            expect.objectContaining({ index: 0, providerId: 'offline', outcome: 'failure' }),
            expect.objectContaining({ index: 1, providerId: 'ok', outcome: 'success' }),
          ],
          outcome: 'success',
        }),
      ],
      usages: [],
    });
  });

  test('Given stream emits data then errors When Responses streams Then request is failure', async () => {
    const dbHome = tempHome();
    const provider = aiSdkProvider(
      () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
            controller.error(new Error('stream broke'));
          },
        }),
    );
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request('/v1/responses', {
      body: JSON.stringify(responsesRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();

    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: 'failure', attempts: [expect.objectContaining({ outcome: 'failure' })] }),
      ],
      usages: [],
    });
  });

  test.each([false, true])(
    'Given an aborted inbound signal and wrapped AbortError When Responses stream is %s Then request is cancelled',
    async (stream) => {
      const dbHome = tempHome();
      const provider = aiSdkProvider(() => {
        let sent = false;
        return new ReadableStream<TextStreamPart<ToolSet>>({
          pull(controller) {
            if (!sent) {
              sent = true;
              controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
            } else {
              controller.error(new AiSdkProviderError('mock-ai', new AbortStreamError('client closed request')));
            }
          },
        });
      });
      const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
      const abort = new AbortController();
      abort.abort();

      const response = await app.request('/v1/responses', {
        body: JSON.stringify({ ...responsesRequest, stream }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
        signal: abort.signal,
      });
      await response.text().catch(() => undefined);

      expect(response.status).toBe(stream ? 200 : 499);
      expect(await recorded(dbHome)).toEqual({
        requests: [
          expect.objectContaining({
            outcome: 'cancelled',
            attempts: [expect.objectContaining({ outcome: 'cancelled' })],
          }),
        ],
        usages: [],
      });
    },
  );
});
