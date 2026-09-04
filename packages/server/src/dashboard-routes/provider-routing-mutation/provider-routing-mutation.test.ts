import { expect, test } from 'bun:test';

import {
  applyProviderRoutingMutation,
  ProviderRoutingSetChangedError,
  providerRoutingRevision,
  ProviderRoutingStaleRevisionError,
} from './provider-routing-mutation';

const current = {
  alpha: {
    kind: 'api',
    baseURL: 'https://alpha.example.test/v1',
    headers: { 'x-tenant': 'one' },
    priority: 20,
    weight: 7,
  },
  beta: { kind: 'api', baseURL: 'https://beta.example.test/v1' },
};

test('updates every Provider routing value while preserving unrelated fields', () => {
  const next = applyProviderRoutingMutation(
    current,
    {
      revision: providerRoutingRevision(current, ['alpha', 'beta']),
      providers: {
        alpha: { priority: 10, weight: 2500 },
        beta: { priority: 10, weight: 7500 },
      },
    },
    ['alpha', 'beta'],
  );

  expect(next).toEqual({
    alpha: {
      kind: 'api',
      baseURL: 'https://alpha.example.test/v1',
      headers: { 'x-tenant': 'one' },
      priority: 10,
      weight: 2500,
    },
    beta: { kind: 'api', baseURL: 'https://beta.example.test/v1', priority: 10, weight: 7500 },
  });
});

test('rejects a stale routing revision', () => {
  expect(() =>
    applyProviderRoutingMutation(
      current,
      {
        revision: providerRoutingRevision({ ...current, alpha: { ...current.alpha, weight: 8 } }, ['alpha', 'beta']),
        providers: { alpha: { priority: 10, weight: 5000 }, beta: { priority: 10, weight: 5000 } },
      },
      ['alpha', 'beta'],
    ),
  ).toThrow(ProviderRoutingStaleRevisionError);
});

test('rejects a Provider set that no longer matches the editable configuration', () => {
  expect(() =>
    applyProviderRoutingMutation(
      current,
      {
        revision: providerRoutingRevision(current, ['alpha', 'beta']),
        providers: { alpha: { priority: 10, weight: 10000 } },
      },
      ['alpha', 'beta'],
    ),
  ).toThrow(ProviderRoutingSetChangedError);
});

test('routing revision ignores unrelated Provider edits but tracks routing and membership', () => {
  const revision = providerRoutingRevision(current, ['alpha', 'beta']);
  expect(providerRoutingRevision({ ...current, alpha: { ...current.alpha, name: 'Alpha' } }, ['alpha', 'beta'])).toBe(
    revision,
  );
  expect(providerRoutingRevision({ ...current, alpha: { ...current.alpha, weight: 8 } }, ['alpha', 'beta'])).not.toBe(
    revision,
  );
  expect(providerRoutingRevision(current, ['alpha'])).not.toBe(revision);
});
