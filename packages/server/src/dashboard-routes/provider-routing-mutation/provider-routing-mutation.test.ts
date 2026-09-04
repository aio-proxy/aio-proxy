import { expect, test } from 'bun:test';

import {
  applyProviderRoutingMutation,
  authoredProviderRouting,
  ProviderRoutingSetChangedError,
  providerRoutingRevision,
  ProviderRoutingStaleRevisionError,
} from './provider-routing-mutation';

const current = {
  alpha: {
    kind: 'api',
    protocol: 'openai-compatible',
    baseURL: 'https://alpha.example.test/v1',
    headers: { 'x-tenant': 'one' },
    priority: 20,
    weight: 7,
  },
  beta: { kind: 'api', protocol: 'openai-compatible', baseURL: 'https://beta.example.test/v1' },
};

test('updates every Provider routing value while preserving unrelated fields', () => {
  const next = applyProviderRoutingMutation(
    current,
    {
      revision: providerRoutingRevision(authoredProviderRouting(current)),
      providers: {
        alpha: { priority: 10, weight: 2500 },
        beta: { priority: 10, weight: 7500 },
      },
    },
    authoredProviderRouting(current),
  );

  expect(next).toEqual({
    alpha: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://alpha.example.test/v1',
      headers: { 'x-tenant': 'one' },
      priority: 10,
      weight: 2500,
    },
    beta: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: 'https://beta.example.test/v1',
      priority: 10,
      weight: 7500,
    },
  });
});

test('rejects a stale routing revision', () => {
  expect(() =>
    applyProviderRoutingMutation(
      current,
      {
        revision: providerRoutingRevision(
          authoredProviderRouting({ ...current, alpha: { ...current.alpha, weight: 8 } }),
        ),
        providers: { alpha: { priority: 10, weight: 5000 }, beta: { priority: 10, weight: 5000 } },
      },
      authoredProviderRouting(current),
    ),
  ).toThrow(ProviderRoutingStaleRevisionError);
});

test('rejects a Provider set that no longer matches the editable configuration', () => {
  expect(() =>
    applyProviderRoutingMutation(
      current,
      {
        revision: providerRoutingRevision(authoredProviderRouting(current)),
        providers: { alpha: { priority: 10, weight: 10000 } },
      },
      authoredProviderRouting(current),
    ),
  ).toThrow(ProviderRoutingSetChangedError);
});

test('routing revision ignores unrelated Provider edits but tracks routing and membership', () => {
  const revision = providerRoutingRevision(authoredProviderRouting(current));
  expect(
    providerRoutingRevision(authoredProviderRouting({ ...current, alpha: { ...current.alpha, name: 'Alpha' } })),
  ).toBe(revision);
  expect(
    providerRoutingRevision(authoredProviderRouting({ ...current, alpha: { ...current.alpha, weight: 8 } })),
  ).not.toBe(revision);
  const { beta: _beta, ...withoutBeta } = current;
  expect(providerRoutingRevision(authoredProviderRouting(withoutBeta))).not.toBe(revision);
});

test('an authored record and the config it parses into produce the same revision', () => {
  // The GET derives the revision from the running config while a save derives it from the record it
  // commits. A record that omits `weight` must digest as the default the runtime applied, or the two
  // would never agree and every save would be rejected as stale.
  expect(providerRoutingRevision(authoredProviderRouting(current))).toBe(
    providerRoutingRevision([
      { id: 'alpha', priority: 20, weight: 7 },
      { id: 'beta', priority: 0, weight: 1 },
    ]),
  );
});

test('a Provider whose value is only valid once templates resolve stays in the routing set', () => {
  process.env['AIO_TEST_ROUTING_MEMBERSHIP_BASE'] = 'https://templated.example.test';
  const templated = {
    alpha: {
      kind: 'api',
      protocol: 'openai-compatible',
      baseURL: '{{env.AIO_TEST_ROUTING_MEMBERSHIP_BASE}}/v1',
      models: ['m'],
    },
  };

  try {
    expect(authoredProviderRouting(templated).map((provider) => provider.id)).toEqual(['alpha']);
  } finally {
    delete process.env['AIO_TEST_ROUTING_MEMBERSHIP_BASE'];
  }
});
