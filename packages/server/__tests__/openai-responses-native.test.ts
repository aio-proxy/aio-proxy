import { afterEach, describe, expect, test } from 'bun:test';

import type { ApiProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import { ProviderProtocol } from '@aio-proxy/types';

import { createTempHomes, recorded, responsesRequest } from './openai-responses.test-support';

const homes = createTempHomes('aio-proxy-responses-usage-');
const tempHome = homes.tempHome;
afterEach(homes.cleanup);

describe('OpenAI Responses routes', () => {
  test('Given openai-response api provider When POST is valid Then raw request and response bytes pass through', async () => {
    // Given
    const rawRequest = '{"model":"gpt-4.1-mini","input":"Say pong.","stream":false}';
    let bodySeen = '';
    const provider = {
      id: 'openai',
      kind: 'api',
      models: ['gpt-4.1-mini'],
      alias: { 'gpt-4.1-mini': { model: 'gpt-4.1-mini', preserve: false } },
      protocol: ProviderProtocol.OpenAIResponse,
      async passthrough(req) {
        bodySeen = await req.text();
        return new Response('{"upstream":true}', {
          headers: { 'content-type': 'application/json', 'x-upstream': '1' },
          status: 203,
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
    const response = await app.request('/v1/responses', {
      body: rawRequest,
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    // Then
    expect(response.status).toBe(203);
    expect(response.headers.get('x-upstream')).toBe('1');
    expect(await response.text()).toBe('{"upstream":true}');
    expect(bodySeen).toBe(rawRequest);
    expect(await recorded(dbHome)).toEqual({
      requests: [
        expect.objectContaining({
          inboundProtocol: ProviderProtocol.OpenAIResponse,
          requestedModelId: 'gpt-4.1-mini',
          finalProviderId: 'openai',
          finalModelId: 'gpt-4.1-mini',
          outcome: 'success',
          attempts: [expect.objectContaining({ index: 0, providerId: 'openai', outcome: 'success' })],
        }),
      ],
      usages: [],
    });
  });

  test('Given an alias variant and native provider When POST is valid Then passthrough receives the variant model', async () => {
    // Given
    let bodySeen: unknown;
    const provider = {
      id: 'openai',
      kind: 'api',
      models: ['gpt-default', 'gpt-high'],
      alias: {
        mini: {
          model: 'gpt-default',
          preserve: false,
          variants: { high: { model: 'gpt-high', preserve: false } },
        },
      },
      protocol: ProviderProtocol.OpenAIResponse,
      async passthrough(req) {
        bodySeen = await req.json();
        return Response.json({ ok: true });
      },
    } satisfies ApiProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request('/v1/responses', {
      body: JSON.stringify({
        ...responsesRequest,
        model: 'mini',
        reasoning: { effort: 'high' },
        future_option: { nested: true },
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    // Then
    expect(response.status).toBe(200);
    expect(bodySeen).toEqual({
      ...responsesRequest,
      model: 'gpt-high',
      reasoning: { effort: 'high' },
      future_option: { nested: true },
    });
  });
});
