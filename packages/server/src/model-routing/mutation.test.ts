import { expect, test } from 'bun:test';

import { digestProviderEntry } from '@aio-proxy/core';

import { applyRoutingMutation, ModelRoutingStaleRevisionError } from './mutation';

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
