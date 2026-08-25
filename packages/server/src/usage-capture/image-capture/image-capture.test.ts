import { expect, test } from 'bun:test';

import { captureImageUsage } from './image-capture';

test('records imageCount and copies only official Images token fields', async () => {
  const usage = await captureImageUsage({
    providerId: 'openai',
    modelId: 'gpt-image-2',
    imageCount: 2,
    usage: {
      input_tokens: 7,
      output_tokens: undefined,
      ignored: 'no',
    },
  });

  expect(usage).toMatchObject({
    providerId: 'openai',
    modelId: 'gpt-image-2',
    imageCount: 2,
    inputTokens: 7,
  });
  expect(usage).not.toHaveProperty('outputTokens');
  expect(usage).not.toHaveProperty('ignored');
});
