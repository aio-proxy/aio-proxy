import { afterEach, expect, test } from 'bun:test';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';

import {
  clearModelsDevCatalog,
  modelsDevModel,
  seedModelsDevCatalog,
  seedModelsDevCatalogUnderVendor,
} from '../../__tests__/server.test-support';
import { routingCatalogFacts } from './catalog-facts';

afterEach(() => {
  clearModelsDevCatalog();
});

// The one test below needs a vendor provider and OpenRouter populated at the
// same time, to prove which of the two resolution wins. Neither shared seed
// helper spans two providers, so borrow seedModelsDevCatalog's isolated catalog
// home (and its afterEach cleanup) by seeding once, then overwrite the catalog
// with a hand-built provider map. For the single-provider nested shape, use
// seedModelsDevCatalogUnderVendor instead of this.
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
  // OpenRouter, whose key here is vendor-prefixed. The resulting slug is
  // `openrouter/mistralai/mistral-large`: OpenRouter resells the model, so the
  // lab is the vendor behind the channel segment.
  await seedModelsDevCatalogUnderVendor('mistralai', {
    'mistral-large': modelsDevModel('mistral-large', 'Mistral Large', { release_date: '2026-03-04' }),
  });

  expect(await routingCatalogFacts('mistral-large')).toEqual({ lab: 'mistralai', releaseDate: '2026-03-04' });
});

test('reports no catalog at all when OpenRouter resells the model under a bare key', async () => {
  // `shared` pins no models.dev provider, so seedModelsDevCatalog's bare
  // OpenRouter key is the one that resolves it and the slug is `openrouter/shared`.
  // Neither segment is a maker: `openrouter` is the reselling channel and
  // `shared` is the model id. A model id reported as its own maker is the same
  // lie as the channel, so the whole catalog block is withheld.
  await seedModelsDevCatalog({ shared: modelsDevModel('shared', 'Shared Model', { release_date: '2026-04-09' }) });

  expect(await routingCatalogFacts('shared')).toBeUndefined();
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
