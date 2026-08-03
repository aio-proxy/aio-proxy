import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';
import { ModelContextAggregation, ProviderKind } from '@aio-proxy/types';

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
  metadata: { 'gpt-5.6-sol': { name: 'Vendor Name' } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

const aliasOnlyProvider = {
  id: 'p2',
  kind: ProviderKind.Api,
  enabled: true,
  alias: { 'my-alias': { model: 'gpt-5.6-sol', preserve: false } },
  model: { invoke: async function* () {} },
} as unknown as RuntimeProviderInstance;

function fakeState(
  providers: readonly RuntimeProviderInstance[],
  aggregation?: (typeof ModelContextAggregation)[keyof typeof ModelContextAggregation],
): ServerState {
  return {
    acquireProviderSnapshot: () => ({
      snapshot: {
        providers,
        ...(aggregation === undefined ? {} : { config: { router: { modelContextAggregation: aggregation } } }),
      },
      release() {},
    }),
  } as unknown as ServerState;
}

// A provider exposing one public slug backed by an upstream model, with optional
// config-level metadata limits for that upstream model.
function slugProvider(
  id: string,
  slug: string,
  modelId: string,
  limit?: { context?: number; input?: number },
): RuntimeProviderInstance {
  return {
    id,
    kind: ProviderKind.Api,
    enabled: true,
    alias: { [slug]: { model: modelId, preserve: false } },
    ...(limit === undefined ? {} : { metadata: { [modelId]: { limit } } }),
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;
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
      contextWindow: undefined,
      effectiveMetadata: undefined,
      maxInput: undefined,
    },
  ]);
});

test('resolveEnabledModels de-dupes by slug and uses alias-slug catalog metadata', async () => {
  const slugMetadata = modelsDevModel('gpt-5', 'gpt-5');
  await seedCatalog({ 'gpt-5': slugMetadata });
  const resolved = await resolveEnabledModels(fakeState([oauthProvider]));
  expect(resolved[0]).toMatchObject({
    slug: 'gpt-5',
    modelId: 'gpt-5.6-sol',
    displayName: 'Vendor Name',
    contextWindow: 128_000,
    maxInput: undefined,
  });
  expect(resolved[0]?.effectiveMetadata?.name).toBe('Vendor Name');
  expect(resolved[0]?.effectiveMetadata?.limit?.context).toBe(128_000);
});

test('displayName prefers the OAuth provider self-reported name for the upstream modelId', async () => {
  await seedCatalog({});
  const resolved = await resolveEnabledModels(fakeState([oauthProvider]));
  expect(resolved[0]?.displayName).toBe('Vendor Name');
});

test('config limit.context wins over config limit.input and over the models.dev limit', async () => {
  // Catalog carries limit.input 500_000; config metadata carries both context and
  // input. context must win, proving config > catalog and context > input.
  await seedCatalog({ 'gpt-ctx': modelsDevModel('gpt-ctx', 'gpt-ctx', { limit: { input: 500_000, output: 8_000 } }) });
  const provider = slugProvider('p1', 'gpt-ctx', 'up-ctx', { context: 300_000, input: 111_000 });
  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved[0]?.contextWindow).toBe(300_000);
});

test('config limit.input wins over the models.dev limit when no config context is set', async () => {
  await seedCatalog({ 'gpt-in': modelsDevModel('gpt-in', 'gpt-in', { limit: { input: 500_000, output: 8_000 } }) });
  const provider = slugProvider('p1', 'gpt-in', 'up-in', { input: 222_000 });
  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved[0]?.contextWindow).toBe(222_000);
});

test('models.dev limit.input is used when config carries no limit', async () => {
  await seedCatalog({ 'gpt-di': modelsDevModel('gpt-di', 'gpt-di', { limit: { input: 400_000, output: 8_000 } }) });
  const provider = slugProvider('p1', 'gpt-di', 'up-di');
  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved[0]?.contextWindow).toBe(400_000);
});

test('models.dev limit.context is used when neither config nor models.dev input is set', async () => {
  await seedCatalog({ 'gpt-dc': modelsDevModel('gpt-dc', 'gpt-dc', { limit: { context: 128_000, output: 8_000 } }) });
  const provider = slugProvider('p1', 'gpt-dc', 'up-dc');
  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved[0]?.contextWindow).toBe(128_000);
});

test('min aggregation exposes the smallest context window across providers sharing a slug', async () => {
  // Two providers publish the same public slug, one capped at 200k and one at 1M.
  await seedCatalog({ 'gpt-shared': modelsDevModel('gpt-shared', 'gpt-shared', { limit: { output: 8_000 } }) });
  const small = slugProvider('p1', 'gpt-shared', 'up-small', { context: 200_000 });
  const large = slugProvider('p2', 'gpt-shared', 'up-large', { context: 1_000_000 });
  const resolved = await resolveEnabledModels(fakeState([small, large], ModelContextAggregation.Min));
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.contextWindow).toBe(200_000);
});

test('max aggregation exposes the largest context window across providers sharing a slug', async () => {
  await seedCatalog({ 'gpt-shared': modelsDevModel('gpt-shared', 'gpt-shared', { limit: { output: 8_000 } }) });
  const small = slugProvider('p1', 'gpt-shared', 'up-small', { context: 200_000 });
  const large = slugProvider('p2', 'gpt-shared', 'up-large', { context: 1_000_000 });
  const resolved = await resolveEnabledModels(fakeState([small, large], ModelContextAggregation.Max));
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.contextWindow).toBe(1_000_000);
});

test('aggregation defaults to min when the snapshot carries no config', async () => {
  await seedCatalog({ 'gpt-shared': modelsDevModel('gpt-shared', 'gpt-shared', { limit: { output: 8_000 } }) });
  const small = slugProvider('p1', 'gpt-shared', 'up-small', { context: 200_000 });
  const large = slugProvider('p2', 'gpt-shared', 'up-large', { context: 1_000_000 });
  const resolved = await resolveEnabledModels(fakeState([small, large]));
  expect(resolved[0]?.contextWindow).toBe(200_000);
});

test('the first candidate in config order supplies the public identity fields', async () => {
  await seedCatalog({ 'gpt-shared': modelsDevModel('gpt-shared', 'gpt-shared', { limit: { output: 8_000 } }) });
  const first = slugProvider('p1', 'gpt-shared', 'up-first', { context: 1_000_000 });
  const second = slugProvider('p2', 'gpt-shared', 'up-second', { context: 200_000 });
  const resolved = await resolveEnabledModels(fakeState([first, second], ModelContextAggregation.Min));
  // Identity comes from the first candidate; only the window aggregates (min => 200k).
  expect(resolved[0]?.modelId).toBe('up-first');
  expect(resolved[0]?.provider).toBe(first);
  expect(resolved[0]?.contextWindow).toBe(200_000);
});

test('maxInput uses config limit.input over catalog, and never falls back to context', async () => {
  // catalog input 500k; config input 272k; both carry a context. maxInput must be
  // the config input (272k), NOT the context window (300k).
  await seedCatalog({ 'gpt-mi': modelsDevModel('gpt-mi', 'gpt-mi', { limit: { input: 500_000, output: 8_000 } }) });
  const provider = slugProvider('p1', 'gpt-mi', 'up-mi', { context: 300_000, input: 272_000 });
  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved[0]?.maxInput).toBe(272_000);
  expect(resolved[0]?.contextWindow).toBe(300_000);
});

test('maxInput uses catalog limit.input when config has none, and is undefined when neither has input', async () => {
  await seedCatalog({ 'gpt-ci': modelsDevModel('gpt-ci', 'gpt-ci', { limit: { input: 400_000, output: 8_000 } }) });
  const withCatalogInput = slugProvider('p1', 'gpt-ci', 'up-ci');
  expect((await resolveEnabledModels(fakeState([withCatalogInput])))[0]?.maxInput).toBe(400_000);

  await seedCatalog({ 'gpt-nc': modelsDevModel('gpt-nc', 'gpt-nc', { limit: { context: 128_000, output: 8_000 } }) });
  const noInput = slugProvider('p2', 'gpt-nc', 'up-nc');
  expect((await resolveEnabledModels(fakeState([noInput])))[0]?.maxInput).toBeUndefined();
});
