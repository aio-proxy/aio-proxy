import { expect, test } from 'bun:test';

import { digestProviderEntry } from '@aio-proxy/core';

import { applyRoutingMutation, ModelRoutingStaleRevisionError, readRawModelPolicy } from './mutation';

test('replaces only baseline Provider entries and preserves newly known or unknown entries', async () => {
  const originalPolicy = {
    providers: { a: { priority: 10 }, b: { weight: 2 }, c: { weight: 7 } },
  };
  const current = { router: { models: { shared: originalPolicy } }, providers: {} };
  const input = {
    modelId: 'shared',
    revision: digestProviderEntry(originalPolicy),
    baselineProviderIds: ['a', 'b'],
    providers: { a: { priority: 30 } },
  };
  const next = applyRoutingMutation(current, input);
  expect(next).toMatchObject({
    router: {
      models: {
        shared: {
          providers: {
            a: { priority: 30 },
            c: { weight: 7 },
          },
        },
      },
    },
  });
  expect(
    (next as { router: { models: { shared: { providers: Record<string, unknown> } } } }).router.models.shared.providers,
  ).not.toHaveProperty('b');
});

test('rejects a stale raw policy without changing config', () => {
  const current = { router: { models: { shared: { providers: { a: { priority: 20 } } } } }, providers: {} };
  const before = structuredClone(current);
  const staleInput = {
    modelId: 'shared',
    revision: digestProviderEntry({ providers: { a: { priority: 10 } } }),
    baselineProviderIds: ['a'],
    providers: { a: { priority: 30 } },
  };
  expect(() => applyRoutingMutation(current, staleInput)).toThrow(ModelRoutingStaleRevisionError);
  expect(current).toEqual(before);
});

test('preserves non-baseline future-only Provider entries byte-semantically', () => {
  const originalPolicy = {
    providers: { a: { priority: 10 }, ghost: { strategy: 'future' } },
  };
  const current = { router: { models: { shared: originalPolicy } }, providers: {} };
  const next = applyRoutingMutation(current, {
    modelId: 'shared',
    revision: digestProviderEntry(originalPolicy),
    baselineProviderIds: ['a'],
    providers: { a: { priority: 30 } },
  });
  expect(
    (next as { router: { models: { shared: { providers: Record<string, unknown> } } } }).router.models.shared.providers,
  ).toEqual({
    a: { priority: 30 },
    ghost: { strategy: 'future' },
  });
});

test('deletes empty model and router containers while preserving future fields', () => {
  const originalPolicy = { providers: { a: { priority: 10 } } };
  const current = {
    router: { models: { shared: originalPolicy, other: { providers: { a: { weight: 2 } }, extra: true } } },
    providers: {},
    keep: true,
  };
  const cleared = applyRoutingMutation(current, {
    modelId: 'shared',
    revision: digestProviderEntry(originalPolicy),
    baselineProviderIds: ['a'],
    providers: {},
  });
  expect(cleared).toEqual({
    router: { models: { other: { providers: { a: { weight: 2 } }, extra: true } } },
    providers: {},
    keep: true,
  });

  const emptied = applyRoutingMutation(
    { router: { models: { shared: originalPolicy } }, providers: {} },
    {
      modelId: 'shared',
      revision: digestProviderEntry(originalPolicy),
      baselineProviderIds: ['a'],
      providers: {},
    },
  );
  expect(emptied).toEqual({ providers: {} });
});

test('does not inherit Object.prototype as a missing model policy', () => {
  const current = { router: { models: {} }, providers: {} };
  expect(readRawModelPolicy(current, 'constructor')).toBeUndefined();
  expect(readRawModelPolicy(current, 'toString')).toBeUndefined();
  expect(digestProviderEntry(readRawModelPolicy(current, 'constructor') ?? null)).toBe(digestProviderEntry(null));
});

test('writes a __proto__ model policy as an own data property', () => {
  const current = { router: { models: {} }, providers: {} };
  const next = applyRoutingMutation(current, {
    modelId: '__proto__',
    revision: digestProviderEntry(null),
    baselineProviderIds: ['a'],
    providers: { a: { priority: 30 } },
  });
  const models = (next as { router: { models: Record<string, unknown> } }).router.models;
  expect(Object.hasOwn(models, '__proto__')).toBe(true);
  expect(Object.getPrototypeOf(models)).toBe(Object.prototype);
  expect(models['__proto__']).toEqual({ providers: { a: { priority: 30 } } });
});

test('routing mutation writes and clears slug metadata', () => {
  const written = applyRoutingMutation(
    {},
    {
      modelId: 'pub',
      revision: digestProviderEntry(null),
      baselineProviderIds: [],
      providers: {},
      metadata: { name: 'Pub' },
    },
  );
  expect(readRawModelPolicy(written, 'pub')).toEqual({ metadata: { name: 'Pub' } });

  const policy = readRawModelPolicy(written, 'pub');
  const cleared = applyRoutingMutation(written, {
    modelId: 'pub',
    revision: digestProviderEntry(policy ?? null),
    baselineProviderIds: [],
    providers: {},
    metadata: null,
  });
  expect(readRawModelPolicy(cleared, 'pub')).toBeUndefined();
});

test('a routing-only submission preserves cost, limit, and unknown keys on the provider entry', () => {
  const policy = {
    metadata: { name: 'Pub' },
    providers: {
      p1: {
        priority: 5,
        cost: { input: 1 },
        limit: { context: 8_000 },
        futureKey: 'keep',
      },
    },
  };
  const seeded = { router: { models: { pub: policy } } };

  const written = applyRoutingMutation(seeded, {
    modelId: 'pub',
    revision: digestProviderEntry(policy),
    baselineProviderIds: ['p1'],
    providers: { p1: { priority: 7 } },
  });

  expect(readRawModelPolicy(written, 'pub')).toEqual({
    metadata: { name: 'Pub' },
    providers: {
      p1: {
        priority: 7,
        cost: { input: 1 },
        limit: { context: 8_000 },
        futureKey: 'keep',
      },
    },
  });
});

test('null clears cost while preserving limit and unknown provider keys', () => {
  const policy = {
    providers: {
      p1: {
        priority: 5,
        cost: { input: 1 },
        limit: { context: 8_000 },
        futureKey: 'keep',
      },
    },
  };
  const written = applyRoutingMutation(
    { router: { models: { pub: policy } } },
    {
      modelId: 'pub',
      revision: digestProviderEntry(policy),
      baselineProviderIds: ['p1'],
      providers: { p1: { cost: null } },
    },
  );

  expect(readRawModelPolicy(written, 'pub')).toEqual({
    providers: {
      p1: {
        limit: { context: 8_000 },
        futureKey: 'keep',
      },
    },
  });
});

test('empty patches preserve metadata-only providers and drop genuinely empty entries', () => {
  const policy = {
    providers: {
      p1: { priority: 5, weight: 2, cost: { input: 1 }, limit: { context: 8_000 } },
      p2: {},
    },
  };
  const written = applyRoutingMutation(
    { router: { models: { pub: policy } } },
    {
      modelId: 'pub',
      revision: digestProviderEntry(policy),
      baselineProviderIds: ['p1', 'p2'],
      providers: { p1: {}, p2: {} },
    },
  );

  expect(readRawModelPolicy(written, 'pub')).toEqual({
    providers: { p1: { cost: { input: 1 }, limit: { context: 8_000 } } },
  });
});
