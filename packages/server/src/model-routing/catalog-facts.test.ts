import { afterEach, expect, test } from 'bun:test';

import { clearModelsDevCatalog, modelsDevModel, seedModelsDevCatalog } from '../../__tests__/server.test-support';
import { routingCatalogFacts } from './catalog-facts';

afterEach(() => {
  clearModelsDevCatalog();
});

test('derives the lab from the catalog slug prefix and carries the release date', async () => {
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5', { release_date: '2026-06-01' }) });

  // The slug is `openai/gpt-5` and the lab is its prefix. models.dev calls that
  // prefix a providerId, but in this repo Provider ID means the upstream
  // provider, so the two must never share a name.
  expect(await routingCatalogFacts('gpt-5')).toEqual({ lab: 'openai', releaseDate: '2026-06-01' });
});

test('returns undefined for an unknown model so a cold catalog is not an error', async () => {
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5') });

  expect(await routingCatalogFacts('not-in-catalog')).toBeUndefined();
});

test('omits releaseDate entirely when the catalog entry has none', async () => {
  // modelsDevModel defaults to release_date: '2026-01-15', so the missing-date
  // branch is only reachable when a test clears it explicitly.
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5', { release_date: undefined }) });

  // toStrictEqual, not toEqual: toEqual ignores a present-but-undefined
  // `releaseDate`, so it could not tell an omitted key from an explicit one.
  expect(await routingCatalogFacts('gpt-5')).toStrictEqual({ lab: 'openai' });
});
