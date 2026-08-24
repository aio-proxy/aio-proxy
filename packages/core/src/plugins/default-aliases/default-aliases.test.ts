import { expect, test } from 'bun:test';

import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';

import { assertAliasTargetsInCatalog, insertMissingAliases, validatedDefaultAliases } from './default-aliases';

const catalog = (): ModelCatalog => ({
  language: [{ id: 'wire-low' }, { id: 'wire-high' }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
});

test('insertMissingAliases keeps existing keys byte-identical and inserts only missing keys', () => {
  const existing = { model: 'edited', preserve: true as const };
  const extraBase = { model: 'keep-me', variants: [{ when: { effort: 'high' as const }, model: 'wire-high' }] };
  const base = { logical: existing, extra: extraBase };
  const suggestedNew = { model: 'wire-low', preserve: false as const };
  const result = insertMissingAliases(
    base,
    {
      logical: { model: 'suggested' },
      extra: { model: 'mutated' },
      fresh: suggestedNew,
    },
    undefined,
  );

  expect(result.logical).toBe(existing);
  expect(result.extra).toBe(extraBase);
  expect(result.fresh).toBe(suggestedNew);
  expect(result).not.toBe(base);
});

test('insertMissingAliases returns the same base object when every suggestion key already exists', () => {
  const base = { logical: { model: 'edited' } };
  expect(insertMissingAliases(base, { logical: { model: 'suggested' } }, undefined)).toBe(base);
  expect(insertMissingAliases(base, {}, undefined)).toBe(base);
});

test('insertMissingAliases treats an empty or unusable models value as no whitelist', () => {
  const base = {};
  const suggestions = { fresh: { model: 'anything' } };
  // Empty means "no restriction" everywhere else in the codebase; a filter that read it as "expose
  // nothing" would stop seeding aliases for every provider that has no whitelist at all.
  expect(insertMissingAliases(base, suggestions, [])).toEqual(suggestions);
  expect(insertMissingAliases(base, suggestions, undefined)).toEqual(suggestions);
  expect(insertMissingAliases(base, suggestions, 'not-an-array')).toEqual(suggestions);
});

test('assertAliasTargetsInCatalog accepts array and record variants whose targets exist', () => {
  const parsed = assertAliasTargetsInCatalog(
    {
      arrayed: {
        model: 'wire-low',
        variants: [{ when: { effort: 'high' }, model: 'wire-high' }],
      },
      recorded: {
        model: 'wire-low',
        variants: { high: { model: 'wire-high' } },
      },
    },
    catalog(),
  );

  expect(parsed.arrayed?.model).toBe('wire-low');
  expect(parsed.recorded?.model).toBe('wire-low');
});

test('assertAliasTargetsInCatalog rejects missing model and variant targets', () => {
  expect(() => assertAliasTargetsInCatalog({ logical: { model: 'missing' } }, catalog())).toThrow(
    'default alias target',
  );
  expect(() =>
    assertAliasTargetsInCatalog(
      {
        logical: {
          model: 'wire-low',
          variants: [{ when: { effort: 'high' }, model: 'missing-high' }],
        },
      },
      catalog(),
    ),
  ).toThrow('default alias target');
});

test('validatedDefaultAliases wraps adapter suggestions and leaves a missing hook undefined', () => {
  const seen: ModelCatalog[] = [];
  const adapter = {
    catalog: {
      defaultAliases: (input: ModelCatalog) => {
        seen.push(input);
        return { logical: { model: 'wire-low' } };
      },
    },
  } as OAuthAdapter;

  expect(validatedDefaultAliases(adapter, catalog())).toEqual({
    logical: { model: 'wire-low', preserve: false },
  });
  expect(seen).toEqual([catalog()]);
  expect(validatedDefaultAliases({ catalog: {} } as OAuthAdapter, catalog())).toBeUndefined();
});
