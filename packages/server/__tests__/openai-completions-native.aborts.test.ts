import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { AiSdkProviderError, type ApiProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';

import {
  AbortStreamError,
  chatRequest,
  createTempHomes,
  mockModelsDevCatalog,
  recorded,
  restoreFetch,
} from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);
const homes = createTempHomes('aio-proxy-openai-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('POST /v1/chat/completions', () => {
  test('Given native response body wraps an inbound AbortError When body fails after headers Then request is cancelled', async () => {
    // Given
    const abort = new AbortController();
    const expected = new AiSdkProviderError('openai', new AbortStreamError('client closed request'));
    let pull = 0;
    const passthrough = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            if (pull++ === 0) {
              controller.enqueue(new TextEncoder().encode('partial'));
              abort.abort();
            } else {
              controller.error(expected);
            }
          },
        }),
        { status: 200 },
      );
    const provider = {
      id: 'openai',
      kind: 'api',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      endpointTransports: [{ protocol: ProviderProtocol.OpenAICompatible, passthrough }],
      passthrough,
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify(chatRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal: abort.signal,
    });

    // Then
    expect(response.status).toBe(200);
    await expect(response.text()).rejects.toBe(expected);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: 'cancelled',
          finalStatusCode: 200,
          attempts: [expect.objectContaining({ outcome: 'cancelled', statusCode: 200 })],
        }),
      ],
      usages: [],
    });
  });

  test('Given native response body wraps an AbortError without inbound cancellation Then request is failure', async () => {
    const expected = new AiSdkProviderError('openai', new AbortStreamError('upstream aborted'));
    const passthrough = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            controller.error(expected);
          },
        }),
        { status: 200 },
      );
    const provider = {
      id: 'openai',
      kind: 'api',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      endpointTransports: [{ protocol: ProviderProtocol.OpenAICompatible, passthrough }],
      passthrough,
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({ config: { providers: {} }, dbHome, providerInstances: [provider] });

    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify(chatRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    await expect(response.text()).rejects.toBe(expected);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          outcome: 'failure',
          finalStatusCode: 200,
          attempts: [expect.objectContaining({ outcome: 'failure', statusCode: 200 })],
        }),
      ],
      usages: [],
    });
  });
});
