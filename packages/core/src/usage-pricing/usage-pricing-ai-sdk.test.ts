import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { calculateEstimatedCost } from './usage-pricing';

const openaiPassthrough = {
  source: 'passthrough',
  protocol: ProviderProtocol.OpenAICompatible,
} as const;

const aiSdk = { source: 'ai-sdk' } as const;

describe('calculateEstimatedCost billable normalization', () => {
  test('keeps subsets in their parents when dedicated prices are not finite', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 100, outputTokens: 80, cacheReadTokens: 40, reasoningTokens: 30 },
        { id: 'model', input: 2, output: 5, cacheRead: Number.NaN, reasoning: Number.POSITIVE_INFINITY },
        openaiPassthrough,
      ),
    ).toEqual({
      // Invalid dedicated prices are treated as missing, so neither subset is peeled.
      estimatedCostUsd: 0.0006,
      priceModelId: 'model',
    });
  });

  test('ai-sdk peels priced cache read and write from inclusive input', () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 4,
          outputTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 3,
        },
        { id: 'priced/model', input: 2, output: 10, cacheRead: 3, cacheWrite: 4, reasoning: 5 },
        aiSdk,
      ),
    ).toEqual({
      // input 1, output 3, cacheRead 2, cacheWrite 1, reasoning 3
      // (1*2 + 3*10 + 2*3 + 1*4 + 3*5) / 1e6
      estimatedCostUsd: 0.000057,
      priceModelId: 'priced/model',
    });
  });

  test('ai-sdk leaves unpriced cacheWrite inside input', () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 4,
          outputTokens: 6,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
        { id: 'priced/model', input: 2, output: 10, cacheRead: 3 },
        aiSdk,
      ),
    ).toEqual({
      // peel only cacheRead → input 2; write stays in input
      // (2*2 + 6*10 + 2*3) / 1e6
      estimatedCostUsd: 0.00007,
      priceModelId: 'priced/model',
    });
  });

  test('ai-sdk does not add unpriced reasoning on top of inclusive output', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 150, reasoningTokens: 50 },
        { id: 'google/gemini', input: 1, output: 2 },
        aiSdk,
      ),
    ).toEqual({
      // (10*1 + 150*2) / 1e6
      estimatedCostUsd: 0.00031,
      priceModelId: 'google/gemini',
    });
  });

  test('clamps peeled parents at zero when subsets exceed totals', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 5, cacheReadTokens: 40, reasoningTokens: 9 },
        { id: 'model', input: 1, output: 2, cacheRead: 0.5, reasoning: 3 },
        openaiPassthrough,
      ),
    ).toEqual({
      // input 0, cache 40, output 0, reasoning 9
      // (0 + 40*0.5 + 0 + 9*3) / 1e6
      estimatedCostUsd: 0.000047,
      priceModelId: 'model',
    });
  });
});
