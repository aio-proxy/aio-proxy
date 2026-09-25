import { afterEach, expect, test } from 'bun:test';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';

import { clearModelsDevCatalog, modelsDevModel, seedModelsDevCatalog } from '../../__tests__/server.test-support';
import { routingCatalogFacts } from './catalog-facts';

afterEach(() => {
  clearModelsDevCatalog();
});

// seedModelsDevCatalog keys every model by a bare id, so it cannot express the
// nested `openrouter/<vendor>/<model>` key real models.dev data uses. Borrow its
// isolated catalog home (and its afterEach cleanup) by seeding once, then
// overwrite the catalog with a hand-built provider map.
async function seedNestedOpenRouterCatalog(providers: Record<string, Record<string, ModelsDevModel>>): Promise<void> {
  await seedModelsDevCatalog({});
  await fileCacheStorage.setItem(
    'models-dev-providers',
    Object.fromEntries(Object.entries(providers).map(([id, models]) => [id, { models }])),
  );
  clearModelsCache();
}

test('derives the lab from the catalog slug prefix and carries the release date', async () => {
  await seedModelsDevCatalog({ 'gpt-5': modelsDevModel('gpt-5', 'GPT-5', { release_date: '2026-06-01' }) });

  // The slug is `openai/gpt-5` and the lab is its prefix. models.dev calls that
  // prefix a providerId, but in this repo Provider ID means the upstream
  // provider, so the two must never share a name.
  expect(await routingCatalogFacts('gpt-5')).toEqual({ lab: 'openai', releaseDate: '2026-06-01' });
});

test('reports the vendor as the lab for a model resolved through the OpenRouter fallback', async () => {
  // `mistral-large` matches no provider glob, so resolution falls through to
  // OpenRouter, whose key is vendor-prefixed. The resulting slug is
  // `openrouter/mistralai/mistral-large`: OpenRouter resells the model, so the
  // lab is the vendor behind the channel segment.
  await seedNestedOpenRouterCatalog({
    openrouter: {
      'mistralai/mistral-large': modelsDevModel('mistralai/mistral-large', 'Mistral Large', {
        release_date: '2026-03-04',
      }),
    },
  });

  expect(await routingCatalogFacts('mistral-large')).toEqual({ lab: 'mistralai', releaseDate: '2026-03-04' });
});

test('keeps the vendor as the lab when the vendor provider resolves the model directly', async () => {
  // The same model is listed under both its vendor and OpenRouter, as real
  // catalogs list resold models. The direct vendor hit wins in resolution, so
  // the OpenRouter copy must not reach the lab.
  await seedNestedOpenRouterCatalog({
    anthropic: { 'claude-sonnet-4.5': modelsDevModel('claude-sonnet-4.5', 'Claude Sonnet 4.5') },
    openrouter: {
      'anthropic/claude-sonnet-4.5': modelsDevModel('anthropic/claude-sonnet-4.5', 'Claude Sonnet 4.5'),
    },
  });

  expect(await routingCatalogFacts('claude-sonnet-4.5')).toEqual({
    lab: 'anthropic',
    releaseDate: '2026-01-15',
  });
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
