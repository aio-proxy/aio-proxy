import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import type { ServerLog } from '../server-log';
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

  test('invalid JSON usage is dropped without altering response bytes', async () => {
    const body = '{"usage":{"prompt_tokens":1.5,"completion_tokens":2,"total_tokens":3.5}}';
    const logs: ServerLog[] = [];
    const captured = createUsageCapture({
      priceCatalogTask: async () => undefined,
      logger: (entry) => logs.push(entry),
    }).passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success', statusCode: 200 });
    expect(logs).toEqual([
      {
        event: 'usage.accounting_dropped',
        source: 'passthrough',
        providerId: 'provider',
        modelId: 'model',
        reason: 'invalid_usage',
        issues: expect.any(Array),
      },
    ]);
  });

  test('invalid Anthropic SSE usage remains invalid after later valid events', async () => {
    const body = [
      'data: {"message":{"usage":{"input_tokens":1.5}}}',
      '',
      'data: {"message":{"usage":{"input_tokens":11}}}',
      '',
      'data: {"usage":{"output_tokens":13}}',
      '',
    ].join('\n');
    const logs: ServerLog[] = [];
    const captured = createUsageCapture({
      priceCatalogTask: async () => undefined,
      logger: (entry) => logs.push(entry),
    }).passthrough({
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      protocol: ProviderProtocol.Anthropic,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success', statusCode: 200 });
    expect(logs).toEqual([
      {
        event: 'usage.accounting_dropped',
        source: 'passthrough',
        providerId: 'provider',
        modelId: 'model',
        reason: 'invalid_usage',
        issues: expect.any(Array),
      },
    ]);
  });
});
