import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { createLiveMetrics } from '../live-metrics';
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

describe('passthrough live throughput', () => {
  beforeEach(() => seedPriceCatalog([]));
  afterEach(() => clearPriceCatalog());

  test.each([true, false, undefined])('counts SSE content and calibrates only when enabled: %s', async (live) => {
    const liveMetrics = createLiveMetrics();
    const record = spyOn(liveMetrics, 'recordContent');
    const calibrate = spyOn(liveMetrics, 'calibrate');
    const body =
      'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"世界"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n';
    const captured = createUsageCapture({ liveMetrics }).passthrough({
      providerId: 'p',
      modelId: 'm',
      protocol: ProviderProtocol.OpenAICompatible,
      ...(live === undefined ? {} : { live }),
      response: new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
    });
    expect(await captured.value.text()).toBe(body);
    expect((await captured.completion).outcome).toBe('success');
    expect(record.mock.calls).toEqual(
      live
        ? [
            ['p/m', 5],
            ['p/m', 2],
          ]
        : [],
    );
    expect(calibrate.mock.calls).toEqual(live ? [['p/m', 7, 2]] : []);
  });

  test.each(['failure', 'cancel', 'idle', 'after-finish'] as const)(
    'calibration follows upstream success: %s',
    async (mode) => {
      const liveMetrics = createLiveMetrics();
      const calibrate = spyOn(liveMetrics, 'calibrate');
      let upstream!: ReadableStreamDefaultController<Uint8Array>;
      const encoder = new TextEncoder();
      const captured = createUsageCapture({ liveMetrics }).passthrough({
        providerId: 'p',
        modelId: 'm',
        protocol: ProviderProtocol.OpenAICompatible,
        live: true,
        idleTimeoutMs: 10,
        response: new Response(
          new ReadableStream({
            start(controller) {
              upstream = controller;
              controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n'));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      });
      const reader = captured.value.body!.getReader();
      await reader.read();
      if (mode === 'after-finish') {
        upstream.enqueue(
          encoder.encode(
            'data: {"usage":{"prompt_tokens":1,"completion_tokens":2,"total_tokens":3}}\n\ndata: [DONE]\n\n',
          ),
        );
        await reader.read();
        expect((await captured.completion).outcome).toBe('success');
        await reader.cancel();
        expect(calibrate.mock.calls).toEqual([['p/m', 5, 2]]);
      } else {
        if (mode === 'failure') {
          upstream.error(new Error('upstream failed'));
          await expect(reader.read()).rejects.toThrow('upstream failed');
        }
        if (mode === 'cancel') await reader.cancel();
        if (mode === 'idle') await expect(reader.read()).rejects.toThrow('stream_idle_timeout');
        expect((await captured.completion).outcome).toBe(mode === 'cancel' ? 'cancelled' : 'failure');
        expect(calibrate).not.toHaveBeenCalled();
      }
    },
  );
});
