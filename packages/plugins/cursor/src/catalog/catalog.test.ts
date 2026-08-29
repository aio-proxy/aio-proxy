import { expect, test } from 'bun:test';

import { initialCursorCatalogFallback, staticCursorCatalog } from './catalog';

test('exposes curated Cursor language models and no other capabilities', () => {
  const catalog = staticCursorCatalog();
  const ids = catalog.language.map((model) => model.id);
  expect(ids).toContain('claude-4.5-sonnet');
  expect(ids).toContain('gpt-5.2-codex');
  expect(catalog.image).toEqual([]);
  expect(catalog.embedding).toEqual([]);
  for (const model of catalog.language) {
    expect((model.extra as { protocol?: unknown } | undefined)?.protocol).toBeUndefined();
  }
});

test('falls back to the curated catalog only for the initial retryable failure', () => {
  expect(initialCursorCatalogFallback(new Error('boom'))).toBeUndefined();
});
