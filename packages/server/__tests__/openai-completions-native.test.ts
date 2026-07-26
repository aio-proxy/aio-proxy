import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { ApiProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';

import {
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
  test('Given openai-compatible api provider When completion is posted Then passthrough receives original request', async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: 'openai',
      kind: 'api',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return new Response('provider-bytes', {
          headers: { 'x-provider': 'openai' },
          status: 202,
        });
      },
    } satisfies ApiProviderInstance;
    const dbHome = tempHome();
    const app = await createServer({
      config: { providers: {} },
      dbHome,
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify(chatRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    // Then
    expect(response.status).toBe(202);
    expect(response.headers.get('x-provider')).toBe('openai');
    expect(await response.text()).toBe('provider-bytes');
    expect(bodySeen).toEqual(chatRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.OpenAICompatible,
          requestedModelId: 'gpt-4o-mini',
          finalProviderId: 'openai',
          finalModelId: 'gpt-4o-mini',
          outcome: 'success',
          attempts: [expect.objectContaining({ index: 0, providerId: 'openai', outcome: 'success' })],
        }),
      ],
      usages: [],
    });
  });

  test('Given openai-compatible api provider When non-stream completion is posted Then passthrough receives original request', async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: 'openai',
      kind: 'api',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAICompatible,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json(
          {
            id: 'chatcmpl-upstream',
            object: 'chat.completion',
            choices: [],
          },
          { status: 200 },
        );
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });
    const request = { ...chatRequest, stream: false };

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify(request),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual({
      id: 'chatcmpl-upstream',
      object: 'chat.completion',
      choices: [],
    });
    expect(bodySeen).toEqual(request);
  });
});
