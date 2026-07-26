import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';

import { calculateEstimatedCost } from './usage-pricing';

const openaiPassthrough = {
  source: 'passthrough',
  protocol: ProviderProtocol.OpenAICompatible,
} as const;

const anthropicPassthrough = {
  source: 'passthrough',
  protocol: ProviderProtocol.Anthropic,
} as const;

const geminiPassthrough = {
  source: 'passthrough',
  protocol: ProviderProtocol.Gemini,
} as const;

describe('calculateEstimatedCost billable normalization', () => {
  test('passthrough OpenAI peels priced cacheRead (CCH 2006/1920/300)', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 2006, outputTokens: 300, cacheReadTokens: 1920 },
        { id: 'openai/gpt-test', input: 2, output: 10, cacheRead: 0.5 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (86*2 + 1920*0.5 + 300*10) / 1e6
      estimatedCostUsd: 0.004132,
      priceModelId: 'openai/gpt-test',
    });
  });

  test('passthrough OpenAI keeps cache tokens in input when cacheRead price is missing', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 2006, outputTokens: 300, cacheReadTokens: 1920 },
        { id: 'openai/gpt-test', input: 2, output: 10 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (2006*2 + 300*10) / 1e6
      estimatedCostUsd: 0.007012,
      priceModelId: 'openai/gpt-test',
    });
  });

  test('passthrough Anthropic does not peel cache from input', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10 },
        { id: 'anthropic/claude', input: 2, output: 10, cacheRead: 0.5, cacheWrite: 3 },
        anthropicPassthrough,
      ),
    ).toEqual({
      // (100*2 + 20*10 + 50*0.5 + 10*3) / 1e6
      estimatedCostUsd: 0.000455,
      priceModelId: 'anthropic/claude',
    });
  });

  test('passthrough Gemini folds unpriced thoughts into output', () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 400,
          reasoningTokens: 50,
        },
        { id: 'google/gemini', input: 1, output: 2, cacheRead: 0.25 },
        geminiPassthrough,
      ),
    ).toEqual({
      // input 600, cache 400, output 150
      // (600*1 + 400*0.25 + 150*2) / 1e6
      estimatedCostUsd: 0.001,
      priceModelId: 'google/gemini',
    });
  });

  test('passthrough Gemini charges priced thoughts on the reasoning line', () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1000,
          outputTokens: 100,
          cacheReadTokens: 400,
          reasoningTokens: 50,
        },
        { id: 'google/gemini', input: 1, output: 2, cacheRead: 0.25, reasoning: 3 },
        geminiPassthrough,
      ),
    ).toEqual({
      // input 600, cache 400, output 100, reasoning 50
      // (600*1 + 400*0.25 + 100*2 + 50*3) / 1e6
      estimatedCostUsd: 0.00105,
      priceModelId: 'google/gemini',
    });
  });

  test('peels priced reasoning from inclusive OpenAI output', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 1000, reasoningTokens: 400 },
        { id: 'perplexity/sonar-deep-research', input: 1, output: 8, reasoning: 3 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (10*1 + 600*8 + 400*3) / 1e6
      estimatedCostUsd: 0.00601,
      priceModelId: 'perplexity/sonar-deep-research',
    });
  });

  test('keeps reasoning inside output when reasoning price is missing', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 10, outputTokens: 1000, reasoningTokens: 400 },
        { id: 'model', input: 1, output: 8 },
        openaiPassthrough,
      ),
    ).toEqual({
      // (10*1 + 1000*8) / 1e6
      estimatedCostUsd: 0.00801,
      priceModelId: 'model',
    });
  });
});
