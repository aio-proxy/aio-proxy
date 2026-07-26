import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createUsageCapture } from './index';

describe('usage capture passthrough observation', () => {
  test('oversized JSON passthrough stays byte-identical and skips usage observation', async () => {
    const body = JSON.stringify({
      padding: 'x'.repeat(2 * 1024 * 1024),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success', statusCode: 200 });
  });

  test('oversized SSE event disables observation without interrupting passthrough', async () => {
    const body =
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
      `data: ${'x'.repeat(2 * 1024 * 1024)}\n\n`;
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success', statusCode: 200 });
  });

  test('SSE observation handles UTF-8 and CRLF split across chunks', async () => {
    const body = 'data:{"content":"🙂","usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\r\n\r\n';
    const bytes = new TextEncoder().encode(body);
    const emojiStart = bytes.indexOf(0xf0);
    const carriageReturn = bytes.indexOf(0x0d);
    const chunks = [
      bytes.slice(0, emojiStart + 2),
      bytes.slice(emojiStart + 2, carriageReturn + 1),
      bytes.slice(carriageReturn + 1),
    ];
    const captured = createUsageCapture({ priceCatalogTask: async () => undefined }).passthrough({
      response: new Response(
        new ReadableStream({
          start(controller) {
            for (const chunk of chunks) {
              controller.enqueue(chunk);
            }
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({ inputTokens: 3, outputTokens: 2, totalTokens: 5 }),
    });
  });
});
