import { describe, expect, test } from 'bun:test';

import { ModelCatalogValidationError, validateModelCatalog } from './catalog';

const emptyCatalog = {
  language: [{ id: 'm' }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};

const validCatalog = () => ({
  language: [{ id: 'language', displayName: 'Language', extra: { nested: [1, true, null] } }],
  image: [{ id: 'image' }],
  embedding: [{ id: 'embedding' }],
  speech: [{ id: 'speech' }],
  transcription: [{ id: 'transcription' }],
  reranking: [{ id: 'reranking' }],
});

describe('validateModelCatalog', () => {
  test('accepts and normalizes all six modalities', () => {
    expect(validateModelCatalog(validCatalog())).toEqual(validCatalog());
  });

  test('accepts a class-based catalog and descriptors', () => {
    class Descriptor {
      readonly id = 'language';
      readonly displayName = 'Language';
    }
    class Catalog {
      readonly language = [new Descriptor()];
      readonly image = [];
      readonly embedding = [];
      readonly speech = [];
      readonly transcription = [];
      readonly reranking = [];
    }
    expect(validateModelCatalog(new Catalog())).toEqual({
      language: [{ id: 'language', displayName: 'Language' }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
  });

  test.each(['language', 'image', 'embedding', 'speech', 'transcription', 'reranking'])(
    'requires the %s modality array',
    (modality) => {
      const catalog = validCatalog() as Record<string, unknown>;
      delete catalog[modality];
      expect(() => validateModelCatalog(catalog)).toThrow(ModelCatalogValidationError);
    },
  );

  test.each([
    ['blank id', { ...validCatalog(), language: [{ id: ' ' }] }],
    ['duplicate id', { ...validCatalog(), language: [{ id: 'same' }, { id: 'same' }] }],
    ['non-string display name', { ...validCatalog(), language: [{ id: 'id', displayName: 1 }] }],
    ['function extra', { ...validCatalog(), language: [{ id: 'id', extra: () => {} }] }],
    ['bigint extra', { ...validCatalog(), language: [{ id: 'id', extra: BigInt(1) }] }],
    ['non-finite extra', { ...validCatalog(), language: [{ id: 'id', extra: Number.POSITIVE_INFINITY }] }],
  ])('rejects %s without exposing the value', (_name, catalog) => {
    try {
      validateModelCatalog(catalog);
      throw new Error('expected validation to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelCatalogValidationError);
      expect(error).not.toHaveProperty('cause');
    }
  });

  test('rejects cyclic extra', () => {
    const extra: Record<string, unknown> = {};
    extra.self = extra;
    expect(() => validateModelCatalog({ ...validCatalog(), language: [{ id: 'id', extra }] })).toThrow(
      ModelCatalogValidationError,
    );
  });
});

test('keeps top-level catalog extra', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    extra: { cursorFamilies: [{ name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium' }] }] },
  });
  expect(catalog.extra).toEqual({
    cursorFamilies: [{ name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium' }] }],
  });
});

test('rejects non-JSON catalog extra', () => {
  expect(() => validateModelCatalog({ ...emptyCatalog, extra: { when: 1n } })).toThrow(ModelCatalogValidationError);
});

test('preserves a valid descriptor modelMetadata, stripping extend and unknown keys like protocol', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    language: [
      {
        id: 'm1',
        extra: { protocol: 'anthropic' },
        modelMetadata: {
          name: 'M1',
          extend: 'openai/gpt-5',
          protocol: 'anthropic',
          limit: { context: 200_000, output: 8192 },
        },
      },
    ],
  });
  expect(catalog.language[0]?.modelMetadata).toEqual({ name: 'M1', limit: { context: 200_000, output: 8192 } });
});

test('drops an invalid descriptor modelMetadata but keeps the descriptor', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    language: [{ id: 'm1', displayName: 'Kept', modelMetadata: { limit: { context: -5 } } }],
  });
  expect(catalog.language[0]).toEqual({ id: 'm1', displayName: 'Kept' });
});

test('drops a modelMetadata that smuggles non-JSON values through a nested loose schema', () => {
  const catalog = validateModelCatalog({
    ...emptyCatalog,
    language: [{ id: 'm1', modelMetadata: { cost: { input: 1, note: () => {} } } }],
  });
  expect(catalog.language[0]?.modelMetadata).toBeUndefined();
});
