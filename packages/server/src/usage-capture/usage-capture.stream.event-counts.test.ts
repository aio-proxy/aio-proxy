import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { clearPriceCatalog, drain, finishPart, seedPriceCatalog, textStream } from './test-support';

// An empty-token finish part exercises the finishUsage === undefined synthesis
// path: normalizeAiSdkUsage returns undefined, yet event counts must still bill.
function emptyFinishPart(): TextStreamPart<ToolSet> {
  return {
    type: 'finish',
    finishReason: 'stop',
    rawFinishReason: 'stop',
    totalUsage: {},
  } as unknown as TextStreamPart<ToolSet>;
}

function part(value: Record<string, unknown>): TextStreamPart<ToolSet> {
  return value as unknown as TextStreamPart<ToolSet>;
}

describe('usage capture stream event counts', () => {
  beforeEach(async () => {
    // No price entries: the completion carries the raw counted UsageRow without
    // a catalog-derived cost, so assertions read the counts directly.
    await seedPriceCatalog([]);
  });

  afterEach(() => {
    clearPriceCatalog();
  });

  test('counts image file parts and web-search tool calls onto the billed usage', async () => {
    const parts = [
      part({ type: 'file', file: { mediaType: 'image/png', base64: '', uint8Array: new Uint8Array() } }),
      part({ type: 'file', file: { mediaType: 'image/png', base64: '', uint8Array: new Uint8Array() } }),
      part({ type: 'tool-call', toolCallId: 't1', toolName: 'web_search_preview', input: {}, providerExecuted: true }),
      finishPart(),
    ] as const;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    const usage = 'usage' in completion ? completion.usage : undefined;
    expect(usage).toEqual(
      expect.objectContaining({
        providerId: 'provider',
        modelId: 'model',
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
        imageCount: 2,
        webSearchCount: 1,
      }),
    );
  });

  test('non-image generated files do not increment imageCount', async () => {
    const parts = [
      part({ type: 'file', file: { mediaType: 'audio/mp3', base64: '', uint8Array: new Uint8Array() } }),
      part({ type: 'reasoning-file', file: { mediaType: 'image/png', base64: '', uint8Array: new Uint8Array() } }),
      finishPart(),
    ] as const;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    const completion = await captured.completion;
    const usage = 'usage' in completion ? completion.usage : undefined;
    expect(usage?.imageCount).toBeUndefined();
  });

  test('non-provider-executed and non-web-search tool calls do not increment webSearchCount', async () => {
    const parts = [
      // Ordinary client function call: no providerExecuted flag.
      part({ type: 'tool-call', toolCallId: 't1', toolName: 'get_weather', input: {} }),
      // Provider-executed but not a web search.
      part({ type: 'tool-call', toolCallId: 't2', toolName: 'code_interpreter', input: {}, providerExecuted: true }),
      finishPart(),
    ] as const;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    const completion = await captured.completion;
    const usage = 'usage' in completion ? completion.usage : undefined;
    expect(usage?.webSearchCount).toBeUndefined();
  });

  test('a cancelled stream does not bill event counts', async () => {
    let cancelled = false;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: new ReadableStream({
        pull(controller) {
          controller.enqueue(
            part({ type: 'file', file: { mediaType: 'image/png', base64: '', uint8Array: new Uint8Array() } }),
          );
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    const reader = captured.value.getReader();

    await reader.read();
    await reader.cancel();

    expect(cancelled).toBe(true);
    await expect(captured.completion).resolves.toEqual({ outcome: 'cancelled' });
  });

  test('image-only stream with empty token usage still bills imageCount', async () => {
    const parts = [
      part({ type: 'file', file: { mediaType: 'image/png', base64: '', uint8Array: new Uint8Array() } }),
      emptyFinishPart(),
    ] as const;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    const usage = 'usage' in completion ? completion.usage : undefined;
    expect(usage).toEqual(expect.objectContaining({ providerId: 'provider', modelId: 'model', imageCount: 1 }));
    // No token usage was reported, so the synthesized row carries only counts.
    expect(usage?.inputTokens).toBeUndefined();
    expect(usage?.webSearchCount).toBeUndefined();
  });
});
