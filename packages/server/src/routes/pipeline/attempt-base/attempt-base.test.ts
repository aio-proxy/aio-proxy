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

test('plugin upstream cost bills when the router policy has no cost', () => {
  const upstream = { input: 5 };
  expect(candidateConfigPrice(undefined, 'pub', 'oauth', upstream)).toEqual({ id: 'pub', input: 5 });
  expect(candidateConfigPrice({ pub: { providers: {} } }, 'pub', 'oauth', upstream)).toEqual({
    id: 'pub',
    input: 5,
  });
  expect(candidateConfigPrice({ pub: { providers: {} } }, 'pub', 'oauth')).toBeUndefined();
});

test('router costs outrank plugin upstream cost', () => {
  const models = {
    pub: {
      metadata: { cost: { input: 10 } },
      providers: { cheap: { cost: { input: 1 } }, other: {} },
    },
  };
  const upstream = { input: 5 };
  expect(candidateConfigPrice(models, 'pub', 'cheap', upstream)).toEqual({ id: 'pub', input: 1 });
  expect(candidateConfigPrice(models, 'pub', 'other', upstream)).toEqual({ id: 'pub', input: 10 });
});
