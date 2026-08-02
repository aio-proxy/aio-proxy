import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Model, Provider, ProviderMap } from '@opencode-ai/models';

import { clearModelsCache, getModels, getModelsCachedOnly } from '.';
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
});
