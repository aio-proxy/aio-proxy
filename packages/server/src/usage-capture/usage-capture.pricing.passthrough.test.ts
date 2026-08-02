import { afterEach, describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';
import { clearPriceCatalog, seedPriceCatalog } from './test-support';

describe('usage capture pricing passthrough', () => {
  afterEach(() => {
    clearPriceCatalog();
  });

  test('passthrough preserves response metadata and bytes while parsing and pricing usage', async () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    // modelId 'priced/model' hits the OpenRouter entry by full id.
    await seedPriceCatalog([{ id: 'priced/model', input: 2, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }]);
    const captured = createUsageCapture().passthrough({
      response: new Response(body, {
        headers: { 'content-type': 'application/json', 'x-upstream': 'yes' },
        status: 200,
        statusText: 'Good',
      }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'priced/model',
    });

    expect(captured.value.status).toBe(200);
    expect(captured.value.statusText).toBe('Good');
    expect(captured.value.headers.get('x-upstream')).toBe('yes');
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 3,
        outputTokens: 2,
        priceModelId: 'priced/model',
        estimatedCostUsd: expect.closeTo(0.000026),
      }),
    });
  });

  test('passthrough OpenAI SSE keeps raw input and peels priced cache', async () => {
    const body = [
      'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{"content":"Hi"}}]}',
      '',
      'data: {"id":"chatcmpl-2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2006,"completion_tokens":300,"total_tokens":2306,"prompt_tokens_details":{"cached_tokens":1920}}}',
      '',
      'data: [DONE]',
    ].join('\n');
    await seedPriceCatalog([{ id: 'openai/gpt-test', input: 2, output: 10, cacheRead: 0.5 }]);
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'openai/gpt-test',
    });
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 2006,
        cacheReadTokens: 1920,
        outputTokens: 300,
        estimatedCostUsd: 0.004132,
        priceModelId: 'openai/gpt-test',
      }),
    });
  });

  test('passthrough OpenAI without cacheRead price does not undercharge', async () => {
    const body = JSON.stringify({
      usage: {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    });
    await seedPriceCatalog([{ id: 'openai/gpt-test', input: 2, output: 10 }]);
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'openai/gpt-test',
    });
    await captured.value.text();
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 2006,
        cacheReadTokens: 1920,
        estimatedCostUsd: 0.007012,
      }),
    });
  });
});

describe('usage capture config price override', () => {
  afterEach(() => {
    clearPriceCatalog();
  });

  test('a hit-channel config price wins over the catalog and marks priceSource config', async () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    // Catalog would bill 100*2 + 50*10 = 700/1e6; the hit channel's config price
    // must win, billing 100*1 + 50*3 = 250/1e6 instead.
    await seedPriceCatalog([{ id: 'priced/model', input: 2, output: 10, cacheRead: 0, cacheWrite: 0, reasoning: 0 }]);
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'priced/model',
      configPrice: { id: 'priced/model', input: 1, output: 3 },
    });

    await captured.value.text();
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({
        inputTokens: 100,
        outputTokens: 50,
        priceModelId: 'priced/model',
        estimatedCostUsd: 250 / 1_000_000,
        priceSource: 'config',
      }),
    });
  });

  test('a config price still bills when the model is absent from the catalog', async () => {
    const body = JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } });
    // Empty catalog: the config price must not fall back to models.dev on a miss.
    await seedPriceCatalog([]);
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' }, status: 200 }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'relay/opaque-id',
      configPrice: { id: 'relay/opaque-id', input: 1, output: 3 },
    });

    await captured.value.text();
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({
        estimatedCostUsd: 250 / 1_000_000,
        priceSource: 'config',
      }),
    });
  });
});
