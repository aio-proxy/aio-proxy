import { afterEach, describe, expect, test } from 'bun:test';

import { AiSdkProviderError, type AiSdkProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import type { TextStreamPart, ToolSet } from 'ai';

import { AbortStreamError, createTempHomes, messagesRequest, recorded } from './anthropic-messages.test-support';

const homes = createTempHomes('aio-proxy-anthropic-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1/messages', () => {
  test('Given stream emits data then errors When message streams Then request is failure', async () => {
    const provider = {
      id: 'broken-after-data',
      kind: 'ai-sdk',
      models: ['claude-sonnet-4-5'],
      alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
      invoke: () =>
        new ReadableStream<TextStreamPart<ToolSet>>({
          start(controller) {
            controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'partial' });
            controller.error(new Error('stream broke'));
          },
        }),
    } satisfies AiSdkProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request('/v1/messages', {
      body: JSON.stringify(messagesRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text().catch(() => undefined);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({ outcome: 'failure', attempts: [expect.objectContaining({ outcome: 'failure' })] }),
      ],
      usages: [],
    });
  });

  test.each([false, true])(
    'Given an aborted inbound signal and wrapped AbortError When Anthropic stream is %s Then request is cancelled',
    async (stream) => {
      const provider = {
        id: 'mock-ai',
        kind: 'ai-sdk',
        models: ['claude-sonnet-4-5'],
        alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
        invoke: () => {
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
        },
      } satisfies AiSdkProviderInstance;
      const dbHome = tempHome();
      const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });
      const abort = new AbortController();
      abort.abort();

      const response = await app.request('/v1/messages', {
        body: JSON.stringify({ ...messagesRequest, stream }),
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

  test.each(['provider rejected', null, { message: 'provider rejected' }])(
    'Given final provider rejects %p When non-stream message is posted Then one failed request is recorded',
    async (reason) => {
      const provider = {
        id: 'mock-ai',
        kind: 'ai-sdk',
        models: ['claude-sonnet-4-5'],
        alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
        invoke: () => new ReadableStream({ pull: (controller) => controller.error(reason) }),
      } satisfies AiSdkProviderInstance;
      const dbHome = tempHome();
      const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

      const response = await app.request('/v1/messages', {
        body: JSON.stringify({ ...messagesRequest, stream: false }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      });

      expect(response.status).toBe(500);
      expect(await recorded(dbHome)).toEqual({
        requests: [
          expect.objectContaining({
            finalProviderId: 'mock-ai',
            outcome: 'failure',
            attempts: [expect.objectContaining({ index: 0, providerId: 'mock-ai', outcome: 'failure' })],
          }),
        ],
        usages: [],
      });
    },
  );
});

describe('POST /v1/messages/count_tokens', () => {});
