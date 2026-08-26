import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import type { ServerLog } from '../server-log';
import { createUsageCapture } from './index';
import { clearPriceCatalog, seedPriceCatalog } from './test-support';

describe('usage capture passthrough observation', () => {
  // Pricing resolves through getProviders(); an empty isolated catalog keeps
  // the usage-observation cases from touching the network.
  beforeEach(async () => {
    await seedPriceCatalog([]);
  });

  afterEach(() => {
    clearPriceCatalog();
  });

  test('oversized JSON passthrough stays byte-identical and still extracts trailing usage', async () => {
    const body = JSON.stringify({
      padding: 'x'.repeat(2 * 1024 * 1024),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
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

  test('oversized JSON passthrough extracts leading usage without buffering the vector payload', async () => {
    const body = JSON.stringify({
      usage: { prompt_tokens: 8, total_tokens: 8 },
      data: [{ embedding: Array.from({ length: 256 * 1024 }, () => 0.1) }],
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
      protocol: ProviderProtocol.OpenAICompatible,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({ inputTokens: 8, totalTokens: 8 }),
    });
  });

  test('oversized Gemini JSON passthrough extracts usageMetadata and ignores nested usage objects', async () => {
    const body = JSON.stringify({
      embeddings: [{ values: Array.from({ length: 256 * 1024 }, () => 0.1), usage: { prompt_tokens: 99 } }],
      usageMetadata: { promptTokenCount: 8, totalTokenCount: 8 },
    });
    const captured = createUsageCapture().passthrough({
      response: new Response(body, { headers: { 'content-type': 'application/json' } }),
      protocol: ProviderProtocol.Gemini,
      providerId: 'provider',
      modelId: 'model',
    });

    expect(await captured.value.text()).toBe(body);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      statusCode: 200,
      usage: expect.objectContaining({ inputTokens: 8, totalTokens: 8 }),
    });
  });

  test('oversized SSE event disables observation without interrupting passthrough', async () => {
    const body =
      'data: {"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}\n\n' +
      `data: ${'x'.repeat(2 * 1024 * 1024)}\n\n`;
    const captured = createUsageCapture().passthrough({
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
    const captured = createUsageCapture().passthrough({
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
