import { describe, expect, test } from 'bun:test';

import type { OpenRouterModelPrice, UsageAccounting } from '@aio-proxy/core';
import type { UsageRow } from '@aio-proxy/types';

import { priceUsage } from './pricing';

// Per-token rates are USD per 1,000,000 tokens (divided by 1e6);
// per-event fees (image/webSearch) are USD per event.
const accounting: UsageAccounting = { source: 'ai-sdk' };
const configPrice: OpenRouterModelPrice = {
  id: 'm',
  input: 2,
  output: 10,
  image: 0.01,
  webSearch: 0.005,
  inputAudio: 3,
  outputAudio: 6,
};

describe('pricingInput forwards fee and audio count fields', () => {
  test('config price includes per-event fees and audio token cost from the usage row', async () => {
    const row: UsageRow = {
      providerId: 'provider',
      modelId: 'm',
      inputTokens: 100,
      outputTokens: 50,
      imageCount: 2,
      webSearchCount: 1,
      inputAudioTokens: 1000,
      outputAudioTokens: 500,
    };

    // tokens: 100*2 + 50*10 = 700 micros
    // audio:  1000*3 + 500*6 = 6000 micros
    // fees:   image 0.01*2 + webSearch 0.005*1 = 0.025 USD = 25000 micros
    // total = (700 + 6000 + 25000) / 1e6 = 0.0317 USD
    const priced = await priceUsage(row, accounting, undefined, configPrice);
    expect(priced).toMatchObject({
      estimatedCostUsd: 0.0317,
      priceModelId: 'm',
      priceSource: 'config',
    });
  });

  test('regression: no counts on the row yields no fee/audio contribution', async () => {
    const row: UsageRow = {
      providerId: 'provider',
      modelId: 'm',
      inputTokens: 100,
      outputTokens: 50,
    };

    // Only tokens: (100*2 + 50*10) / 1e6 = 0.0007 USD; the same configPrice's
    // image/webSearch/audio rates contribute nothing when the row omits counts.
    const priced = await priceUsage(row, accounting, undefined, configPrice);
    expect(priced).toMatchObject({
      estimatedCostUsd: 0.0007,
      priceModelId: 'm',
      priceSource: 'config',
    });
  });
});
