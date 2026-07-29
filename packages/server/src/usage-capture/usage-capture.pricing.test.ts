import { afterEach, describe, expect, test } from 'bun:test';

import type { TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { clearPriceCatalog, drain, seedPriceCatalog, textStream } from './test-support';

describe('usage capture pricing stream', () => {
  afterEach(() => {
    clearPriceCatalog();
  });

  test('ai-sdk Gemini-shaped usage does not double-count unpriced thoughts', async () => {
    // Priced via OpenRouter bare id: modelId 'gemini' resolves to 'google/gemini'.
    await seedPriceCatalog([{ id: 'google/gemini', input: 1, output: 2 }]);
    const finish: TextStreamPart<ToolSet> = {
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 10 },
        inputTokens: 10,
        outputTokenDetails: { reasoningTokens: 50, textTokens: 100 },
        outputTokens: 150,
        totalTokens: 160,
      },
    };
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'gemini',
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({
        inputTokens: 10,
        outputTokens: 150,
        reasoningTokens: 50,
        // (10*1 + 150*2) / 1e6 — reasoning not added again
        estimatedCostUsd: 0.00031,
        priceModelId: 'google/gemini',
      }),
    });
  });

  test('ai-sdk Anthropic-shaped usage peels priced cache read and write once', async () => {
    await seedPriceCatalog([{ id: 'anthropic/claude', input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }]);
    const finish: TextStreamPart<ToolSet> = {
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: 40, cacheWriteTokens: 10, noCacheTokens: 50 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: undefined, textTokens: 20 },
        outputTokens: 20,
        totalTokens: 120,
      },
    };
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'claude',
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({
        inputTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        // billable input 50: (50*2 + 20*10 + 40*0.5 + 10*3) / 1e6
        estimatedCostUsd: 0.00035,
        priceModelId: 'anthropic/claude',
      }),
    });
  });

  test('prices by the requested model even when the upstream modelId also resolves to a different price', async () => {
    await seedPriceCatalog([
      // Both resolve, but the client asked for the requested model; the routed
      // upstream id must never win pricing.
      { id: 'vendor/requested-model', input: 2, output: 10 },
      { id: 'relay/upstream-model', input: 99, output: 99 },
    ]);
    const finish: TextStreamPart<ToolSet> = {
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 100 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: undefined, textTokens: 10 },
        outputTokens: 10,
        totalTokens: 110,
      },
    };
    const captured = createUsageCapture().stream({
      providerId: 'relay',
      // Routed upstream id: resolves to a price, but must be ignored.
      modelId: 'relay/upstream-model',
      requestedModelId: 'vendor/requested-model',
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({
        // (100*2 + 10*10) / 1e6 — priced by the requested model, not upstream-model
        estimatedCostUsd: 0.0003,
        priceModelId: 'vendor/requested-model',
      }),
    });
  });

  test('falls back to the upstream modelId when no requested model was captured', async () => {
    await seedPriceCatalog([{ id: 'anthropic/claude', input: 2, output: 10 }]);
    const finish: TextStreamPart<ToolSet> = {
      type: 'finish',
      finishReason: 'stop',
      rawFinishReason: 'stop',
      totalUsage: {
        inputTokenDetails: { cacheReadTokens: undefined, cacheWriteTokens: undefined, noCacheTokens: 100 },
        inputTokens: 100,
        outputTokenDetails: { reasoningTokens: undefined, textTokens: 10 },
        outputTokens: 10,
        totalTokens: 110,
      },
    };
    const captured = createUsageCapture().stream({
      providerId: 'provider',
      modelId: 'claude',
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({
        estimatedCostUsd: 0.0003,
        priceModelId: 'anthropic/claude',
      }),
    });
  });
});
