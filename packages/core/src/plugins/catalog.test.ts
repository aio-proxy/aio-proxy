import { expect, test } from 'bun:test';

import { ModelCatalogValidationError, validateModelCatalog } from './catalog';

const empty = {
  language: [{ id: 'm' }],
  image: [],
  embedding: [],
  speech: [],
  transcription: [],
  reranking: [],
};

test('keeps top-level catalog metadata', () => {
  const catalog = validateModelCatalog({
    ...empty,
    metadata: { cursorFamilies: [{ name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium' }] }] },
  });
  expect(catalog.metadata).toEqual({
    cursorFamilies: [{ name: 'claude-opus-4-8', variants: [{ slug: 'claude-opus-4-8-medium' }] }],
  });
});

test('rejects non-JSON catalog metadata', () => {
  expect(() => validateModelCatalog({ ...empty, metadata: { when: 1n } })).toThrow(ModelCatalogValidationError);
});
