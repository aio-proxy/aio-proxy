import { describe, expect, test } from 'bun:test';

import { ProviderProtocol } from '@aio-proxy/types';
import type { ModelCost } from '@aio-proxy/types';

import { calculateEstimatedCost, configModelPrice } from './usage-pricing';

const aiSdk = { source: 'ai-sdk' } as const;

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

describe('configModelPrice', () => {
  test('maps a single field with no extra keys', () => {
    expect(configModelPrice('p/m', { input: 2 })).toEqual({ id: 'p/m', input: 2 });
  });

  test('maps every field and turns config tiers into engine threshold tiers', () => {
    const cost: ModelCost = {
      input: 2,
      output: 10,
      cacheRead: 0.5,
      cacheWrite: 3,
      reasoning: 4,
      inputAudio: 5,
      outputAudio: 20,
      image: 0.01,
      webSearch: 0.02,
      request: 0.005,
      tiers: [
        { tier: { type: 'context', size: 200_000 }, input: 4, output: 15, inputAudio: 8 },
        { tier: { type: 'context', size: 1_000_000 }, input: 6 },
      ],
    };
    expect(configModelPrice('p/m', cost)).toEqual({
      id: 'p/m',
      input: 2,
      output: 10,
      cacheRead: 0.5,
      cacheWrite: 3,
      reasoning: 4,
      inputAudio: 5,
      outputAudio: 20,
      image: 0.01,
      webSearch: 0.02,
      request: 0.005,
      tiers: [
        { threshold: 200_000, input: 4, output: 15, inputAudio: 8 },
        { threshold: 1_000_000, input: 6 },
      ],
    });
  });
});

describe('calculateEstimatedCost audio, fees, and context tiers', () => {
  test('charges split audio, per-event fees once each, and the highest crossed tier', () => {
    expect(
      calculateEstimatedCost(
        {
          inputTokens: 1500,
          outputTokens: 300,
          inputAudioTokens: 100,
          outputAudioTokens: 50,
          imageCount: 2,
          webSearchCount: 1,
        },
        {
          id: 'p/m',
          input: 2,
          output: 10,
          inputAudio: 5,
          outputAudio: 20,
          image: 0.01,
          webSearch: 0.02,
          request: 0.005,
          tiers: [{ threshold: 1000, input: 4, output: 15 }],
        },
        aiSdk,
      ),
    ).toEqual({
      // tier (input 1500 > 1000) overlays input:4, output:15
      // tokens: 1500*4 + 300*15 + 100*5 + 50*20
      // fees (once each): 0.01*2*1e6 + 0.02*1e6 + 0.005*1e6
      estimatedCostUsd:
        (1500 * 4 + 300 * 15 + 100 * 5 + 50 * 20 + 0.01 * 2 * 1_000_000 + 0.02 * 1_000_000 + 0.005 * 1_000_000) /
        1_000_000,
      priceModelId: 'p/m',
    });
  });

  test('selects the highest crossed tier with strict greater-than', () => {
    expect(
      calculateEstimatedCost(
        { inputTokens: 200_000 },
        {
          id: 'p/m',
          input: 2,
          tiers: [
            { threshold: 100_000, input: 4 },
            { threshold: 200_000, input: 6 },
            { threshold: 500_000, input: 8 },
          ],
        },
        aiSdk,
      ),
    ).toEqual({
      // inputTokens 200_000 strictly exceeds only 100_000 -> input:4
      estimatedCostUsd: (200_000 * 4) / 1_000_000,
      priceModelId: 'p/m',
    });
  });
});
