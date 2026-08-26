import { expect, test } from 'bun:test';

import { createUsageCapture } from './usage-capture';

const ids = { providerId: 'p1', modelId: 'text-embedding-3-small' } as const;

test('mirrors the reported prompt tokens onto inputTokens and totalTokens', async () => {
  const completion = await createUsageCapture().embedding({ usage: { tokens: 12 }, ...ids });

  expect(completion).toMatchObject({
    outcome: 'success',
    usage: { providerId: 'p1', modelId: 'text-embedding-3-small', inputTokens: 12, totalTokens: 12 },
  });
});

test('succeeds without a usage row when the provider reported no token count', async () => {
  const completion = await createUsageCapture().embedding({ usage: {}, ...ids });

  expect(completion).toEqual({ outcome: 'success' });
});

test('drops the row rather than billing a fractional token count', async () => {
  const completion = await createUsageCapture().embedding({ usage: { tokens: 1.5 }, ...ids });

  expect(completion).toEqual({ outcome: 'success' });
});

test('drops the row rather than billing a token count beyond safe integers', async () => {
  const completion = await createUsageCapture().embedding({ usage: { tokens: Number.MAX_SAFE_INTEGER + 2 }, ...ids });

  expect(completion).toEqual({ outcome: 'success' });
});

test('bills a configured per-request fee even when the token count is unknown', async () => {
  const completion = await createUsageCapture().embedding({
    usage: undefined,
    ...ids,
    configPrice: { id: ids.modelId, request: 0.02 },
  });

  expect(completion).toMatchObject({ outcome: 'success', usage: { estimatedCostUsd: 0.02, priceSource: 'config' } });
});
