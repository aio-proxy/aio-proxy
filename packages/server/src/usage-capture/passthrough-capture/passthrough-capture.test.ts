import { describe, expect, test } from 'bun:test';

import type { OpenRouterModelPrice } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

import { passthroughCapture } from './passthrough-capture';

// A configured flat per-request fee must be billed on a body-less 2xx success
// (e.g. HTTP 204), where there is no token usage to observe.
describe('body-less success billing', () => {
  test('body-null 2xx with a positive request fee bills the flat fee', async () => {
    const configPrice: OpenRouterModelPrice = { id: 'model', request: 0.005 };
    const captured = passthroughCapture(
      {
        response: new Response(null, { status: 204 }),
        protocol: ProviderProtocol.OpenAICompatible,
        providerId: 'provider',
        modelId: 'model',
        configPrice,
      },
      undefined,
    );

    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    expect(completion.statusCode).toBe(204);
    // seedForRequestFee synthesizes a minimal row so priceUsage bills the fee;
    // the request fee (0.005 USD) surfaces as the row's estimated cost.
    if (completion.outcome !== 'success') throw new Error('expected success');
    expect(completion.usage).toMatchObject({
      providerId: 'provider',
      modelId: 'model',
      estimatedCostUsd: 0.005,
      priceSource: 'config',
    });
  });

  test('body-null 2xx without a request fee produces no phantom usage', async () => {
    const captured = passthroughCapture(
      {
        response: new Response(null, { status: 204 }),
        protocol: ProviderProtocol.OpenAICompatible,
        providerId: 'provider',
        modelId: 'model',
      },
      undefined,
    );

    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    expect(completion.statusCode).toBe(204);
    if (completion.outcome !== 'success') throw new Error('expected success');
    expect(completion.usage).toBeUndefined();
  });
});
