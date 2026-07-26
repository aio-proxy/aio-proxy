import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

describe('usage capture passthrough completion', () => {
  test('passthrough consumer cancellation forwards the reason and completes as cancelled', async () => {
    const firstChunk = new TextEncoder().encode('first');
    const cleanupError = new Error('test cleanup');
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelledReason: unknown;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            sourceController = controller;
            controller.enqueue(firstChunk);
          },
          cancel(reason) {
            cancelledReason = reason;
          },
        }),
        { headers: { 'x-upstream': 'yes' }, status: 200, statusText: 'Good' },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });
    const body = captured.value.body;
    if (body === null) {
      throw new Error('expected passthrough response body');
    }
    const reader = body.getReader();
    const reason = new Error('consumer stopped');

    expect(captured.value.status).toBe(200);
    expect(captured.value.statusText).toBe('Good');
    expect(captured.value.headers.get('x-upstream')).toBe('yes');
    expect(await reader.read()).toEqual({ done: false, value: firstChunk });
    const cancellation = reader.cancel(reason);
    await Promise.resolve();
    if (cancelledReason === undefined) {
      sourceController.error(cleanupError);
    }
    await cancellation.catch(() => undefined);

    expect(cancelledReason).toBe(reason);
    await expect(captured.completion).resolves.toEqual({ outcome: 'cancelled', statusCode: 200 });
  });

  test('passthrough body errors remain visible and complete as failure', async () => {
    const expected = new Error('upstream body broke');
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('partial'));
            controller.error(expected);
          },
        }),
        { status: 200 },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    await expect(captured.value.text()).rejects.toBe(expected);
    await expect(captured.completion).resolves.toEqual({ outcome: 'failure', statusCode: 200 });
  });

  test('non-success passthrough completes immediately as failure without consuming the body', async () => {
    const response = new Response('rate limited', { status: 429 });
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response,
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(captured.value).toBe(response);
    expect(await captured.value.text()).toBe('rate limited');
    await expect(captured.completion).resolves.toEqual({ outcome: 'failure', statusCode: 429 });
  });
});
