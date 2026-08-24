import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { ApiProviderInstance } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { createServer } from '#server-test-lifecycle';

import { chatRequest, mockModelsDevCatalog, restoreFetch } from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe('POST /v1/chat/completions', () => {
  test('Given an alias variant and native provider When completion is posted Then passthrough receives the variant model', async () => {
    // Given
    let bodySeen: unknown;
    const passthrough = async (req: Request) => {
      bodySeen = await req.json();
      return Response.json({ ok: true });
    };
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
      protocol: ProviderProtocol.OpenAICompatible,
      endpointTransports: [{ protocol: ProviderProtocol.OpenAICompatible, passthrough }],
      passthrough,
    } satisfies ApiProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify({ ...chatRequest, model: 'mini', reasoning_effort: 'high' }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });

    // Then
    expect(response.status).toBe(200);
    expect(bodySeen).toEqual({ ...chatRequest, model: 'gpt-high', reasoning_effort: 'high' });
  });
});
