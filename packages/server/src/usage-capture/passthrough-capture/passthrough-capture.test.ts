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

// /v1/audio/speech returns binary audio. Above MAX_PASSTHROUGH_JSON_BYTES the
// oversize-body fallback scans raw bytes for a top-level `usage` object without
// validating that the body is JSON at all, so an incidental byte run inside an
// mp3 could otherwise be billed as real upstream token usage.
describe('binary audio bodies never fabricate usage', () => {
  test('an oversize speech body containing usage-shaped bytes bills nothing', async () => {
    const body = new Uint8Array(2 * 1024 * 1024);
    body.fill(0xfb);
    // The scan only tracks keys at depth 1, so an opening brace has to precede
    // the usage-shaped run for it to be captured — `{` is byte 0x7b, which occurs
    // constantly in real audio frame data.
    body[0] = 0x7b;
    body.set(new TextEncoder().encode('"usage":{"input_tokens":999}'), 4096);

    const captured = passthroughCapture(
      {
        response: new Response(body, { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
        protocol: ProviderProtocol.OpenAIAudio,
        providerId: 'provider',
        modelId: 'tts-1',
      },
      undefined,
    );
    await captured.value.arrayBuffer();

    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    if (completion.outcome !== 'success') throw new Error('expected success');
    expect(completion.usage).toBeUndefined();
  });

  test('a transcription JSON body under the cap still bills its reported tokens', async () => {
    const captured = passthroughCapture(
      {
        response: new Response(
          JSON.stringify({ text: 'hi', usage: { type: 'tokens', input_tokens: 12, output_tokens: 3 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        protocol: ProviderProtocol.OpenAIAudio,
        providerId: 'provider',
        modelId: 'whisper-1',
      },
      undefined,
    );
    await captured.value.arrayBuffer();

    const completion = await captured.completion;
    if (completion.outcome !== 'success') throw new Error('expected success');
    expect(completion.usage).toMatchObject({ inputTokens: 12, outputTokens: 3 });
  });

  test('an oversize verbose_json transcription still bills its reported tokens', async () => {
    // The gate is the content type, not the protocol: a long `verbose_json`
    // transcript over the cap is real JSON carrying a real usage object, so
    // disabling the scan for the whole audio protocol would silently drop it.
    const filler = 'word '.repeat(500_000);
    const captured = passthroughCapture(
      {
        response: new Response(
          JSON.stringify({ text: filler, usage: { type: 'tokens', input_tokens: 40, output_tokens: 900 } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
        protocol: ProviderProtocol.OpenAIAudio,
        providerId: 'provider',
        modelId: 'whisper-1',
      },
      undefined,
    );
    await captured.value.arrayBuffer();

    const completion = await captured.completion;
    if (completion.outcome !== 'success') throw new Error('expected success');
    expect(completion.usage).toMatchObject({ inputTokens: 40, outputTokens: 900 });
  });
});
