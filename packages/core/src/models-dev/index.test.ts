import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Model, Provider, ProviderMap } from '@opencode-ai/models';

import { clearModelsCache, getCachedModelSlugs, getModels, getModelsCachedOnly } from '.';
import { fileCacheStorage } from '../cache';

const model = (id: string, name = id): Model => ({
  attachment: false,
  description: '',
  id,
  last_updated: '2026-01-15',
  limit: { context: 128_000, output: 8_000 },
  modalities: { input: ['text'], output: ['text'] },
  name,
  open_weights: false,
  reasoning: false,
  release_date: '2026-01-15',
  tool_call: false,
});

const provider = (id: string, models: Record<string, Model>): Provider => ({
  doc: `https://example.com/${id}`,
  env: [],
  id,
  models,
  name: id,
  npm: `@ai-sdk/${id}`,
});

// Seeded so getProviders reads this map from the file cache instead of the network.
const providerMap: ProviderMap = {
  openai: provider('openai', { 'gpt-5': model('gpt-5') }),
  anthropic: provider('anthropic', { 'claude-4': model('claude-4') }),
  google: provider('google', { 'gemini-2': model('gemini-2') }),
  openrouter: provider('openrouter', {
    'vendor/mistral-large': model('vendor/mistral-large'),
  }),
};

const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'aio-proxy-models-dev-'));
  process.env.AIO_PROXY_HOME = home;
  await fileCacheStorage.setItem('models-dev-providers', providerMap);
  clearModelsCache();
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

describe('getModels', () => {
  test('resolves an explicit provider/model id', async () => {
    const result = await getModels(['openai/gpt-5']);
    expect(result['openai/gpt-5']?.id).toBe('gpt-5');
  });

  test('keeps the full model id when an explicit id has extra slashes', async () => {
    const result = await getModels(['openrouter/vendor/mistral-large']);
    expect(result['openrouter/vendor/mistral-large']?.id).toBe('vendor/mistral-large');
  });

  test('routes known prefixes to their pinned provider', async () => {
    const result = await getModels(['gpt-5', 'claude-4', 'gemini-2']);
    expect(result['gpt-5']?.id).toBe('gpt-5');
    expect(result['claude-4']?.id).toBe('claude-4');
    expect(result['gemini-2']?.id).toBe('gemini-2');
  });

  test('falls back to OpenRouter by full id or bare model id', async () => {
    const result = await getModels(['vendor/mistral-large', 'mistral-large']);
    expect(result['vendor/mistral-large']?.id).toBe('vendor/mistral-large');
    expect(result['mistral-large']?.id).toBe('vendor/mistral-large');
  });

  test('returns undefined for an unknown id', async () => {
    const result = await getModels(['no-such-model']);
    expect(result).toHaveProperty('no-such-model');
    expect(result['no-such-model']).toBeUndefined();
  });

  test('re-querying an unknown id stays undefined (misses are not cached)', async () => {
    await getModels(['no-such-model']);
    const result = await getModels(['no-such-model']);
    expect(result['no-such-model']).toBeUndefined();
  });

  test('clearModelsCache lets a re-seeded provider map take effect for the same id', async () => {
    expect((await getModels(['gpt-5']))['gpt-5']?.name).toBe('gpt-5');
    await fileCacheStorage.setItem('models-dev-providers', {
      openai: provider('openai', { 'gpt-5': model('gpt-5', 'GPT-5 Renamed') }),
    });
    clearModelsCache();
    expect((await getModels(['gpt-5']))['gpt-5']?.name).toBe('GPT-5 Renamed');
  });
});

describe('getModelsCachedOnly', () => {
  test('resolves from the file-cached provider map without a network fetch', async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://models.dev/api.json') fetched = true;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const result = await getModelsCachedOnly(['gpt-5']);
      expect(result['gpt-5']?.id).toBe('gpt-5');
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('returns undefined without fetching when the provider map is absent', async () => {
    // Drop the seeded map so the file cache misses; a cold catalog must not
    // trigger a network fetch on the hot path.
    await fileCacheStorage.removeItem('models-dev-providers');
    clearModelsCache();
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://models.dev/api.json') fetched = true;
      return originalFetch(input, init);
    }) as typeof fetch;
    try {
      const result = await getModelsCachedOnly(['gpt-5']);
      expect(result['gpt-5']).toBeUndefined();
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('caches an unresolved custom id so a repeat lookup skips the disk read', async () => {
    // A custom id absent from models.dev must not re-read + parse the whole
    // provider catalog from disk on every request; the negative cache absorbs
    // the repeat while the catalog stays warm.
    const spy = spyOn(fileCacheStorage, 'getItem');
    try {
      expect((await getModelsCachedOnly(['custom-model']))['custom-model']).toBeUndefined();
      const afterFirst = spy.mock.calls.length;
      expect(afterFirst).toBeGreaterThan(0);
      expect((await getModelsCachedOnly(['custom-model']))['custom-model']).toBeUndefined();
      expect(spy.mock.calls.length).toBe(afterFirst);
    } finally {
      spy.mockRestore();
    }
  });

  test('does not cache a miss when the catalog is cold, so it retries once warm', async () => {
    // Cold catalog (no provider map): a miss must stay uncached so the very
    // next request resolves once the file cache is warmed, rather than being
    // pinned undefined for the negative TTL.
    await fileCacheStorage.removeItem('models-dev-providers');
    clearModelsCache();
    expect((await getModelsCachedOnly(['gpt-5']))['gpt-5']).toBeUndefined();
    await fileCacheStorage.setItem('models-dev-providers', providerMap);
    expect((await getModelsCachedOnly(['gpt-5']))['gpt-5']?.id).toBe('gpt-5');
  });

  test('resolves distinct ids beyond the resolved-model LRU without re-reading the catalog per id', async () => {
    // The resolved-model LRU only holds hits and is capped at 16. Resolving
    // more than that many distinct hits must not JSON-parse the whole catalog
    // from disk once per id; the in-memory provider map serves every resolve
    // after the first read.
    const models: Record<string, Model> = {};
    for (let i = 0; i < 20; i++) models[`bulk-${i}`] = model(`bulk-${i}`);
    await fileCacheStorage.setItem('models-dev-providers', {
      openrouter: provider('openrouter', models),
    });
    clearModelsCache();
    const spy = spyOn(fileCacheStorage, 'getItem');
    try {
      const ids = Object.keys(models);
      const result = await getModelsCachedOnly(ids);
      for (const id of ids) expect(result[id]?.id).toBe(id);
      // One disk read for the whole batch, not one per id.
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });

  test('serves a follow-up lookup from the memory-cached provider map after LRU eviction', async () => {
    // Even across separate calls, an id evicted from the 16-entry LRU resolves
    // from the memory-cached provider map rather than a fresh disk read.
    const models: Record<string, Model> = {};
    for (let i = 0; i < 20; i++) models[`bulk-${i}`] = model(`bulk-${i}`);
    await fileCacheStorage.setItem('models-dev-providers', {
      openrouter: provider('openrouter', models),
    });
    clearModelsCache();
    await getModelsCachedOnly(Object.keys(models)); // warms memory cache, evicts early ids from LRU
    const spy = spyOn(fileCacheStorage, 'getItem');
    try {
      const result = await getModelsCachedOnly(['bulk-0']);
      expect(result['bulk-0']?.id).toBe('bulk-0');
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

test('getCachedModelSlugs returns [] on a cold cache and sorted provider/model slugs on a warm one', async () => {
  await fileCacheStorage.removeItem('models-dev-providers'); // drop the beforeEach seed so the file cache misses
  clearModelsCache();

  // Cached-only is a hot-path promise: opening the drawer must never reach the
  // network. Reject instead of calling through so a regression fails fast.
  const originalFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = (() => {
    fetched = true;
    throw new Error('getCachedModelSlugs must not fetch');
  }) as typeof fetch;

  try {
    expect(await getCachedModelSlugs()).toEqual([]);

    await fileCacheStorage.setItem('models-dev-providers', {
      // Insertion order is deliberately NOT sorted order: without `.sort()` this
      // yields openrouter's slug first and the assertion below fails.
      // One slash-bearing key on purpose: 54% of real models.dev ids contain a
      // slash and `resolveModel` splits on the FIRST slash only, so a slug like
      // `openrouter/vendor/model-z` must round-trip through `extend` unchanged.
      openrouter: { models: { 'vendor/model-z': { id: 'vendor/model-z' } } },
      anthropic: { models: { 'claude-x': { id: 'claude-x' } } },
      // No `models` at all: the cache is unvalidated, so this shape is reachable
      // and `Object.keys(undefined)` would throw without the `?? {}` guard.
      broken: {},
    });
    clearModelsCache();
    expect(await getCachedModelSlugs()).toEqual(['anthropic/claude-x', 'openrouter/vendor/model-z']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  expect(fetched).toBe(false);
});
