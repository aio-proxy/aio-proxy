import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import type { ServerLog } from '../server-log';
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
        priceSource: 'models-dev',
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

  test('records ttft from startedAt to the first content delta when streaming', async () => {
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      startedAt: performance.now(),
      stream: textStream([{ type: 'text-delta', id: 'text-1', text: 'hi' }, finishPart()]),
    });

    await drain(captured.value);
    const completion = await captured.completion;
    expect(completion.outcome).toBe('success');
    const ttftMs = 'ttftMs' in completion ? completion.ttftMs : undefined;
    expect(typeof ttftMs).toBe('number');
    expect(ttftMs).toBeGreaterThanOrEqual(0);
  });

  test('omits ttft when startedAt is not provided', async () => {
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream([{ type: 'text-delta', id: 'text-1', text: 'hi' }, finishPart()]),
    });

    await drain(captured.value);
    const completion = await captured.completion;
    expect('ttftMs' in completion ? completion.ttftMs : undefined).toBeUndefined();
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

describe('usage capture stream validation', () => {
  test('invalid finish usage is dropped without altering stream parts', async () => {
    const finish = finishPart();
    const invalidFinish = {
      ...finish,
      totalUsage: { ...finish.totalUsage, inputTokens: Number.MAX_SAFE_INTEGER + 1 },
    } satisfies TextStreamPart<ToolSet>;
    const logs: ServerLog[] = [];
    const captured = createUsageCapture({
      logger: (entry) => logs.push(entry),
    }).stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream([invalidFinish]),
    });

    expect(await drain(captured.value)).toEqual([invalidFinish]);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success' });
    expect(logs).toEqual([
      {
        event: 'usage.accounting_dropped',
        source: 'ai-sdk',
        providerId: 'provider',
        modelId: 'model',
        reason: 'invalid_usage',
        issues: expect.any(Array),
      },
    ]);
  });

  test('invalid priced usage is dropped and logged', async () => {
    await seedPriceCatalog([{ id: 'priced/model', input: -1, output: 0 }]);
    const logs: ServerLog[] = [];
    const captured = createUsageCapture({
      logger: (entry) => logs.push(entry),
    }).stream({
      providerId: 'provider',
      modelId: 'model',
      stream: textStream([finishPart()]),
    });

    expect(await drain(captured.value)).toEqual([finishPart()]);
    await expect(captured.completion).resolves.toEqual({ outcome: 'success' });
    expect(logs).toEqual([
      {
        event: 'usage.accounting_dropped',
        source: 'ai-sdk',
        providerId: 'provider',
        modelId: 'model',
        reason: 'invalid_usage',
        issues: expect.any(Array),
      },
    ]);
  });
});
