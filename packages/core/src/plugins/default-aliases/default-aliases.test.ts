import { expect, test } from 'bun:test';

import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';

import { pluginDefaultAliases } from './default-aliases';

const catalog = (): ModelCatalog => ({
  language: [{ id: 'wire-low' }, { id: 'wire-high' }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

test('pluginDefaultAliases keeps catalog-valid entries and drops bad neighbors', () => {
  const adapter = {
    catalog: {
      defaultAliases: () => ({
        good: { model: 'wire-low' },
        also: { model: 'wire-high', variants: { high: { model: 'wire-high' } } },
        missing: { model: 'gone' },
        broken: true,
        variantMissing: {
          model: 'wire-low',
          variants: [{ when: { effort: 'high' }, model: 'missing-high' }],
        },
      }),
    },
  } as OAuthAdapter;

  expect(pluginDefaultAliases(adapter, catalog())).toEqual({
    good: { model: 'wire-low', preserve: false },
    also: {
      model: 'wire-high',
      preserve: false,
      variants: [{ when: { effort: 'high' }, model: 'wire-high', preserve: false }],
    },
  });
});

test('pluginDefaultAliases treats a throwing hook or missing hook as empty', () => {
  expect(pluginDefaultAliases({ catalog: {} } as OAuthAdapter, catalog())).toBeUndefined();
  expect(
    pluginDefaultAliases(
      {
        catalog: {
          defaultAliases: () => {
            throw new Error('boom');
          },
        },
      } as OAuthAdapter,
      catalog(),
    ),
  ).toBeUndefined();
});

test('pluginDefaultAliases ignores a non-object hook return', () => {
  expect(
    pluginDefaultAliases({ catalog: { defaultAliases: () => ['logical'] } } as unknown as OAuthAdapter, catalog()),
  ).toBeUndefined();
});
