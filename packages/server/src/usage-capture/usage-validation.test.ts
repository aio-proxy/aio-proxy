import { expect, test } from 'bun:test';

import { finalizeUsage } from './usage-validation';

test('bills configured cost.request when the response carries no token usage', async () => {
  const row = await finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    providerId: 'p1',
    modelId: 'm1',
    configPrice: { id: 'm1', request: 0.02 }, // USD 0.02 per request
  });
  expect(row).toBeDefined();
  expect(row?.providerId).toBe('p1');
  expect(row?.modelId).toBe('m1');
  expect(row?.estimatedCostUsd).toBe(0.02);
  expect(row?.priceSource).toBe('config');
});

test('does not synthesize a row when there is no usage and no request fee', async () => {
  const row = await finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    providerId: 'p1',
    modelId: 'm1',
    configPrice: { id: 'm1', input: 2 }, // token price only, no request fee
  });
  expect(row).toBeUndefined();
});

test('does not synthesize a row when providerId/modelId are absent', async () => {
  const row = await finalizeUsage({
    usage: undefined,
    accounting: { source: 'ai-sdk' },
    configPrice: { id: 'm1', request: 0.02 },
  });
  expect(row).toBeUndefined();
});
