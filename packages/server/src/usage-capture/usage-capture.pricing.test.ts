import { describe, expect, test } from 'bun:test';

import type { OpenRouterPriceCatalog, TextStreamPart, ToolSet } from '@aio-proxy/core';

import { createUsageCapture } from './index';
import { drain, textStream } from './test-support';

describe('usage capture pricing stream', () => {
  test('ai-sdk Gemini-shaped usage does not double-count unpriced thoughts', async () => {
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: 'google/gemini', input: 1, output: 2 }),
    };
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
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
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
    const catalog: OpenRouterPriceCatalog = {
      find: () => ({ id: 'anthropic/claude', input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 }),
    };
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
    const captured = createUsageCapture({ priceCatalogTask: async () => catalog }).stream({
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
});
