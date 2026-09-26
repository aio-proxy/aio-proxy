import { expect, test } from '@rstest/core';

import { UNKNOWN_LAB, filterRoutingModels, labOf, labOptions, sortRoutingModels } from './routing-rows';

const model = (modelId: string, catalog?: { lab: string; releaseDate?: string }, eligible = 2) =>
  ({
    modelId,
    revision: 'r',
    baselineProviderIds: [],
    providerCount: 2,
    eligibleProviderCount: eligible,
    hasOverrides: false,
    tiers: [],
    providers: [],
    ...(catalog === undefined ? {} : { catalog }),
  }) as Parameters<typeof labOf>[0];

test('groups a model with no catalog under a single unknown lab', () => {
  expect(labOf(model('x'))).toBe(UNKNOWN_LAB);
  expect(labOf(model('y', { lab: 'openai' }))).toBe('openai');
});

test('orders by lab, then newest release first, then model id', () => {
  const sorted = sortRoutingModels([
    model('z-old', { lab: 'openai', releaseDate: '2026-01' }),
    model('a-new', { lab: 'openai', releaseDate: '2026-08' }),
    model('claude', { lab: 'anthropic', releaseDate: '2026-05' }),
  ]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['claude', 'a-new', 'z-old']);
});

test('sinks the unknown lab to the very end, not into alphabetical order', () => {
  // 'unknown' would sort between 'openai' and 'zhipu' alphabetically; it must not.
  const sorted = sortRoutingModels([model('mystery'), model('gpt', { lab: 'openai' }), model('glm', { lab: 'zhipu' })]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['gpt', 'glm', 'mystery']);
});

test('sinks a model with no release date to the end of its own lab', () => {
  const sorted = sortRoutingModels([
    model('undated', { lab: 'openai' }),
    model('dated', { lab: 'openai', releaseDate: '2026-02' }),
  ]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['dated', 'undated']);
});

test('compares release dates as strings across mixed precision', () => {
  // '2026-03-15' > '2026-03' lexicographically, which is the sensible reading, and parsing
  // either into a Date would introduce a timezone shift.
  const sorted = sortRoutingModels([
    model('month', { lab: 'openai', releaseDate: '2026-03' }),
    model('day', { lab: 'openai', releaseDate: '2026-03-15' }),
  ]);

  expect(sorted.map((entry) => entry.modelId)).toEqual(['day', 'month']);
});

test('filters by lab and by a config-derived risk', () => {
  const models = [model('a', { lab: 'openai' }, 0), model('b', { lab: 'anthropic' }), model('c')];

  expect(filterRoutingModels(models, { range: '24h', lab: 'openai' }, undefined).map((m) => m.modelId)).toEqual(['a']);
  expect(filterRoutingModels(models, { range: '24h', risk: 'no-eligible' }, undefined).map((m) => m.modelId)).toEqual([
    'a',
  ]);
  expect(filterRoutingModels(models, { range: '24h', lab: UNKNOWN_LAB }, undefined).map((m) => m.modelId)).toEqual([
    'c',
  ]);
});

test('yields nothing for a deviation filter while traffic is unknown', () => {
  // Filtering by deviation with no traffic must not silently fall back to "everything".
  const models = [model('a', { lab: 'openai' })];

  expect(filterRoutingModels(models, { range: '24h', risk: 'deviating' }, undefined)).toEqual([]);
});

test('offers each lab once, with unknown last', () => {
  const models = [
    model('a'),
    model('b', { lab: 'openai' }),
    model('c', { lab: 'openai' }),
    model('d', { lab: 'anthropic' }),
  ];

  expect(labOptions(models)).toEqual(['anthropic', 'openai', UNKNOWN_LAB]);
});
