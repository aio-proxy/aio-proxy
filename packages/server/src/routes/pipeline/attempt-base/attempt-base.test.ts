import { expect, test } from 'bun:test';

import { candidateConfigPrice } from '../attempt-base';

test('per-provider cost override outranks slug cost for billing', () => {
  const models = {
    pub: {
      metadata: { cost: { input: 10 } },
      providers: { cheap: { cost: { input: 1 } }, other: {} },
    },
  };
  expect(candidateConfigPrice(models, 'pub', 'cheap')).toEqual({ id: 'pub', input: 1 });
  expect(candidateConfigPrice(models, 'pub', 'other')).toEqual({ id: 'pub', input: 10 });
  expect(candidateConfigPrice(models, 'missing', 'cheap')).toBeUndefined();
});
