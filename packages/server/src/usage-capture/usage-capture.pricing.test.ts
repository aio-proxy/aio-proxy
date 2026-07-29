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

  test('prices the resolved target model, not the requested alias, when the target has a catalog entry', async () => {
    await seedPriceCatalog([
      // Both resolve; the Router-selected target (usage.modelId) is the billed
      // model, so an alias/variant that maps to a priced target uses it.
      { id: 'vendor/requested-alias', input: 2, output: 10 },
      { id: 'vendor/resolved-target', input: 5, output: 20 },
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
      providerId: 'vendor',
      // Router-resolved target: this is the authoritative billed model.
      modelId: 'vendor/resolved-target',
      requestedModelId: 'vendor/requested-alias',
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({
        // (100*5 + 10*20) / 1e6 — priced by the resolved target, not the alias
        estimatedCostUsd: 0.0007,
        priceModelId: 'vendor/resolved-target',
      }),
    });
  });

  test('falls back to the requested model when the resolved target has no catalog entry', async () => {
    await seedPriceCatalog([{ id: 'vendor/requested-alias', input: 2, output: 10 }]);
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
      // Opaque relay id absent from the catalog.
      modelId: 'relay/opaque-upstream-id',
      requestedModelId: 'vendor/requested-alias',
      stream: textStream([finish]),
    });
    await drain(captured.value);
    await expect(captured.completion).resolves.toEqual({
      outcome: 'success',
      usage: expect.objectContaining({
        // (100*2 + 10*10) / 1e6 — priced by the requested alias
        estimatedCostUsd: 0.0003,
        priceModelId: 'vendor/requested-alias',
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
