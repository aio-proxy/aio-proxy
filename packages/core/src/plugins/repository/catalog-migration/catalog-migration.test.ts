import { expect, test } from 'bun:test';

import { migrateStoredCatalogShape } from './catalog-migration';

const empty = { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] };

test('renames pre-rename descriptor and catalog metadata to extra', () => {
  const migrated = migrateStoredCatalogShape({
    ...empty,
    language: [{ id: 'm1', metadata: { protocol: 'anthropic' } } as never],
    metadata: { note: 'catalog-level' },
  } as never);
  expect(migrated.language[0]).toEqual({ id: 'm1', extra: { protocol: 'anthropic' } });
  expect(migrated.extra).toEqual({ note: 'catalog-level' });
  expect('metadata' in migrated).toBe(false);
});

test('extra wins when both extra and a stray legacy metadata key are present', () => {
  const migrated = migrateStoredCatalogShape({
    ...empty,
    language: [{ id: 'm1', extra: { protocol: 'openai-response' }, metadata: { protocol: 'anthropic' } } as never],
    extra: { keep: true },
    metadata: { stale: true },
  } as never);
  expect(migrated.language[0]).toEqual({ id: 'm1', extra: { protocol: 'openai-response' } });
  expect(migrated.extra).toEqual({ keep: true });
  expect('metadata' in migrated).toBe(false);
});

test('leaves post-rename catalogs identical', () => {
  const catalog = { ...empty, language: [{ id: 'm1', extra: { protocol: 'openai-response' } }] };
  expect(migrateStoredCatalogShape(catalog)).toEqual(catalog);
});

test('does not repair structural damage — a missing modality stays missing for the validator', () => {
  const broken = { language: [{ id: 'm1', metadata: { protocol: 'anthropic' } }] } as never;
  const migrated = migrateStoredCatalogShape(broken);
  expect(migrated.language[0]).toEqual({ id: 'm1', extra: { protocol: 'anthropic' } });
  expect('image' in migrated).toBe(false);
});

test('passes null and primitive descriptors through untouched for the validator to reject', () => {
  const broken = { ...empty, language: [null, 42, 'x', { id: 'ok', metadata: { keep: 1 } }] } as never;
  const migrated = migrateStoredCatalogShape(broken);
  expect(migrated.language).toEqual([null, 42, 'x', { id: 'ok', extra: { keep: 1 } }] as never);
});

test('a non-object catalog is returned as-is', () => {
  expect(migrateStoredCatalogShape(null as never)).toBeNull();
  expect(migrateStoredCatalogShape('broken' as never)).toBe('broken');
});
