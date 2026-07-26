import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';
import { resolveEnabledModels } from './model-resolution';

// Metadata now resolves through models.dev (fileCacheStorage keyed off
// AIO_PROXY_HOME) rather than an injected catalog. Seed the provider map on an
// isolated home so each case controls exactly which slug carries metadata.
const modelsDevModel = (id: string, name: string, overrides: Partial<ModelsDevModel> = {}): ModelsDevModel => ({
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
  ...overrides,
});

const original = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'model-resolution-'));
  process.env.AIO_PROXY_HOME = home;
  clearModelsCache();
});

afterEach(() => {
  clearModelsCache();
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

// Seed models.dev provider map keyed by the alias slug each route queries. The
// slug is placed under both openrouter and its prefix-pinned provider so
// getModels resolves it regardless of which branch the slug takes.
async function seedCatalog(models: Record<string, ModelsDevModel>): Promise<void> {
  const providerModels: Record<string, Record<string, ModelsDevModel>> = {
    anthropic: {},
    google: {},
    openai: {},
    openrouter: {},
  };
  const prefixProvider = (slug: string): string =>
    slug.startsWith('claude-')
      ? 'anthropic'
      : slug.startsWith('gemini-')
        ? 'google'
        : slug.startsWith('gpt-')
          ? 'openai'
          : 'openrouter';
  for (const [slug, model] of Object.entries(models)) {
    providerModels.openrouter[slug] = model;
    providerModels[prefixProvider(slug)][slug] = model;
  }
  const providers = Object.fromEntries(Object.entries(providerModels).map(([id, models]) => [id, { models }]));
  await fileCacheStorage.setItem('models-dev-providers', providers);
}

const oauthProvider = {
  id: 'p1',
  kind: ProviderKind.OAuth,
  enabled: true,
  alias: { 'gpt-5': { model: 'gpt-5.6-sol', preserve: false } },
  modelMetadata: { 'gpt-5.6-sol': { displayName: 'Vendor Name' } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

const aliasOnlyProvider = {
  id: 'p2',
  kind: ProviderKind.Api,
  enabled: true,
  alias: { 'my-alias': { model: 'gpt-5.6-sol', preserve: false } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(providers: readonly RuntimeProviderInstance[]): ServerState {
  return {
    acquireProviderSnapshot: () => ({
      snapshot: { providers },
      release() {},
    }),
  } as unknown as ServerState;
}

test('resolveEnabledModels reads metadata only from the alias slug, never the upstream modelId', async () => {
  // alias "my-alias" has no catalog entry; upstream "gpt-5.6-sol" does. The upstream
  // entry must NOT leak into the alias's public view.
  await seedCatalog({ 'gpt-5.6-sol': modelsDevModel('gpt-5.6-sol', 'Upstream Name') });
  const resolved = await resolveEnabledModels(fakeState([aliasOnlyProvider]));
  expect(resolved).toEqual([
    {
      slug: 'my-alias',
      modelId: 'gpt-5.6-sol',
      provider: aliasOnlyProvider,
      metadata: undefined,
      displayName: 'my-alias',
    },
  ]);
});

test('resolveEnabledModels de-dupes by slug and uses alias-slug catalog metadata', async () => {
  const slugMetadata = modelsDevModel('gpt-5', 'gpt-5');
  await seedCatalog({ 'gpt-5': slugMetadata });
  const resolved = await resolveEnabledModels(fakeState([oauthProvider]));
  expect(resolved).toEqual([
    {
      slug: 'gpt-5',
      modelId: 'gpt-5.6-sol',
      provider: oauthProvider,
      metadata: slugMetadata,
      displayName: 'Vendor Name',
    },
  ]);
});

test('displayName prefers the OAuth provider self-reported name for the upstream modelId', async () => {
  await seedCatalog({});
  const resolved = await resolveEnabledModels(fakeState([oauthProvider]));
  expect(resolved[0]?.displayName).toBe('Vendor Name');
});
