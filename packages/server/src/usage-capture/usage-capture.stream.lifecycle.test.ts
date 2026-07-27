import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { clearPriceCatalog, drain, finishPart, seedPriceCatalog, textStream } from './test-support';

describe('usage capture stream lifecycle', () => {
  // Seed an empty price catalog by default so lookups resolve to no price
  // without touching the network; the pricing case overrides it.
  beforeEach(async () => {
    await seedPriceCatalog([]);
  });

  afterEach(() => {
    clearPriceCatalog();
  });

  test('a stream without a finish part is failure', async () => {
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream([{ type: 'text-delta', id: 'text-1', text: 'hello' }]),
    });

    expect(await drain(captured.value)).toEqual([{ type: 'text-delta', id: 'text-1', text: 'hello' }]);
    await expect(captured.completion).resolves.toEqual({ outcome: 'failure' });
  });

  test('an abort part cancels a normally closed stream and remains visible', async () => {
    const parts = [
      { type: 'text-delta', id: 'text-1', text: 'hello' },
      { type: 'abort' },
    ] as const satisfies readonly TextStreamPart<ToolSet>[];
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    await expect(captured.completion).resolves.toEqual({ outcome: 'cancelled' });
  });

  test('a normally closed stream with finish is success and priced before completion', async () => {
    // bare id of 'priced/model' is 'model', so modelId 'model' resolves the price.
    await seedPriceCatalog([{ id: 'priced/model', input: 2, output: 10, cacheRead: 3, cacheWrite: 4, reasoning: 5 }]);
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream([finishPart()]),
    });

    expect(await drain(captured.value)).toEqual([finishPart()]);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: {
        providerId: 'provider',
        modelId: 'model',
        inputTokens: 4,
        outputTokens: 6,
        totalTokens: 10,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 3,
        priceModelId: 'priced/model',
        estimatedCostUsd: 0.000057,
      },
    });
  });

  test('consumer cancellation resolves cancelled', async () => {
    let cancelled = false;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: new ReadableStream({
        pull(controller) {
          controller.enqueue({ type: 'text-delta', id: 'text-1', text: 'hello' });
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

  test('pricing failures do not alter stream parts', async () => {
    const parts = [{ type: 'text-delta', id: 'text-1', text: 'hello' }, finishPart()] as const;
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream(parts),
    });

    expect(await drain(captured.value)).toEqual(parts);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({ providerId: 'provider', modelId: 'model', inputTokens: 4 }),
    });
  });
});
