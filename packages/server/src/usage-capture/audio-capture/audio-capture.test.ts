import { expect, test } from 'bun:test';

import { captureAudioUsage } from './audio-capture';

test('bills a configured per-request fee even though a binary audio response reports no tokens', async () => {
  const usage = await captureAudioUsage({
    providerId: 'openai',
    modelId: 'tts-1',
    configPrice: { id: 'tts-1', request: 0.015 },
  });

  expect(usage).toMatchObject({
    providerId: 'openai',
    modelId: 'tts-1',
    estimatedCostUsd: 0.015,
    priceSource: 'config',
  });
  // Audio duration and byte counts are never turned into token counts.
  expect(usage).not.toHaveProperty('inputTokens');
  expect(usage).not.toHaveProperty('outputTokens');
  expect(usage).not.toHaveProperty('totalTokens');
});
