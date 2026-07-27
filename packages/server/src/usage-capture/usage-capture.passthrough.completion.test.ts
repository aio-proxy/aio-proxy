import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

describe('oversized SSE passthrough completion', () => {
  test('oversized SSE failure event completes as failure without changing the response', async () => {
    const chunks = [`event: response.`, `failed\r\ndata: ${'x'.repeat(1024 * 1024 + 1)}\r\n`, '\r', '\n'];
    const body = chunks.join('');
    const captured = createUsageCapture().passthrough({
      response: new Response(streamText(chunks), {
        headers: { 'content-type': 'text/event-stream' },
        status: 206,
        statusText: 'Partial Content',
      }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(captured.value.status).toBe(206);
    expect(captured.value.statusText).toBe('Partial Content');
    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: 'failure', statusCode: 206 });
  });

  test('oversized SSE success event remains a successful passthrough', async () => {
    const body =
      'event: response.failed\nevent: response.output_text.delta\n' + `data: ${'x'.repeat(1024 * 1024 + 1)}\n\n`;
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAIResponse,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success', statusCode: 200 });
  });
});

function streamText(chunks: readonly string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('usage capture passthrough completion', () => {
  test.each([
    [
      'OpenAI Responses',
      ProviderProtocol.OpenAIResponse,
      'event: response.failed\ndata: {"type":"response.failed","response":{"status":"failed"}}\n\n',
    ],
    [
      'Anthropic',
      ProviderProtocol.Anthropic,
      'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ],
    [
      'OpenAI-compatible',
      ProviderProtocol.OpenAICompatible,
      'data: {"error":{"type":"server_error","message":"Unavailable"}}\n\n',
    ],
    [
      'Gemini',
      ProviderProtocol.Gemini,
      'data: {"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"Unavailable"}}\n\n',
    ],
  ] as const)(
    '2xx %s SSE protocol failure completes as failure without changing bytes',
    async (_name, protocol, body) => {
      const captured = createUsageCapture().passthrough({
        response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
        protocol,
        providerId: 'provider',
        modelId: 'model',
      });

      expect(await captured.value.text()).toBe(body);
      await expect(captured.completion).resolves.toEqual({ outcome: 'failure', statusCode: 200 });
    },
  );

  test('passthrough consumer cancellation forwards the reason and completes as cancelled', async () => {
    const firstChunk = new TextEncoder().encode('first');
    const cleanupError = new Error('test cleanup');
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    let cancelledReason: unknown;
    const captured = createUsageCapture().passthrough({
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
    const captured = createUsageCapture().passthrough({
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
    const captured = createUsageCapture().passthrough({
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
