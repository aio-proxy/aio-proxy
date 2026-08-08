import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';
import { ModelContextAggregation, ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';
import {
  resolveAggregatedLimit,
  resolveEnabledModels,
  resolveModelCapabilities,
  resolveModelField,
} from './model-resolution';

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
  upstreamMetadata: { 'gpt-5.6-sol': { name: 'Vendor Name' } },
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
  limit?: { context?: number; input?: number; output?: number },
): RuntimeProviderInstance {
  return {
    id,
    kind: ProviderKind.Api,
    enabled: true,
    alias: { [slug]: { model: modelId, preserve: false } },
    ...(limit === undefined ? {} : { configMetadata: { [modelId]: { limit } } }),
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
      candidates: [
        {
          modelId: 'gpt-5.6-sol',
          provider: aliasOnlyProvider,
          configMetadata: undefined,
          upstreamMetadata: undefined,
        },
      ],
      fallbackMetadata: undefined,
      aggregation: ModelContextAggregation.Min,
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
    provider: oauthProvider,
  });
  expect(resolveModelField(resolved[0]!, (metadata) => metadata.name)).toBe('Vendor Name');
  expect(resolveAggregatedLimit(resolved[0]!, 'context')).toBe(128_000);
});

test('resolves config over upstream over public-slug fallback for each limit field', async () => {
  await seedCatalog({
    shared: modelsDevModel('shared', 'Fallback', {
      limit: { context: 1_050_000, input: 922_000, output: 128_000 },
    }),
  });
  const provider = {
    id: 'p1',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { shared: { model: 'upstream', preserve: false } },
    configMetadata: { upstream: { name: 'Configured', limit: { input: 272_000 } } },
    upstreamMetadata: { upstream: { name: 'Catalog', limit: { context: 400_000, output: 64_000 } } },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const model = (await resolveEnabledModels(fakeState([provider])))[0]!;
  expect(resolveModelField(model, (metadata) => metadata.name)).toBe('Configured');
  expect(resolveAggregatedLimit(model, 'context')).toBe(400_000);
  expect(resolveAggregatedLimit(model, 'input')).toBe(272_000);
  expect(resolveAggregatedLimit(model, 'output')).toBe(64_000);
});

test('aggregates context, input, and output independently across candidates', async () => {
  await seedCatalog({});
  const first = slugProvider('p1', 'shared', 'up-first', {
    context: 400_000,
    input: 272_000,
    output: 128_000,
  });
  const second = slugProvider('p2', 'shared', 'up-second', {
    context: 300_000,
    input: 250_000,
    output: 64_000,
  });

  const min = (await resolveEnabledModels(fakeState([first, second], ModelContextAggregation.Min)))[0]!;
  expect(min.modelId).toBe('up-first');
  expect(min.provider).toBe(first);
  expect(resolveAggregatedLimit(min, 'context')).toBe(300_000);
  expect(resolveAggregatedLimit(min, 'input')).toBe(250_000);
  expect(resolveAggregatedLimit(min, 'output')).toBe(64_000);

  const max = (await resolveEnabledModels(fakeState([first, second], ModelContextAggregation.Max)))[0]!;
  expect(resolveAggregatedLimit(max, 'context')).toBe(400_000);
  expect(resolveAggregatedLimit(max, 'input')).toBe(272_000);
  expect(resolveAggregatedLimit(max, 'output')).toBe(128_000);
});

test('uses only the first candidate for non-aggregated fields', async () => {
  await seedCatalog({});
  const provider = (id: string, modelId: string, name: string, structuredOutput: boolean, releaseDate: string) =>
    ({
      id,
      kind: ProviderKind.Api,
      enabled: true,
      alias: { shared: { model: modelId, preserve: false } },
      configMetadata: { [modelId]: { name, capabilities: { structuredOutput, releaseDate } } },
      model: { invoke: async function* () {} },
    }) as unknown as RuntimeProviderInstance;
  const first = provider('p1', 'up-first', 'First', false, '1970-01-02');
  const second = provider('p2', 'up-second', 'Second', true, '1970-01-03');

  const model = (await resolveEnabledModels(fakeState([first, second])))[0]!;
  expect(resolveModelField(model, (metadata) => metadata.name)).toBe('First');
  expect(resolveModelField(model, (metadata) => metadata.capabilities?.releaseDate)).toBe('1970-01-02');
  expect(resolveModelCapabilities(model)?.structuredOutput).toBe(false);
});

test('ignores missing candidate limits for both min and max aggregation', async () => {
  await seedCatalog({});
  const missing = slugProvider('p1', 'shared', 'up-missing');
  const present = slugProvider('p2', 'shared', 'up-present', { output: 64_000 });

  const min = (await resolveEnabledModels(fakeState([missing, present], ModelContextAggregation.Min)))[0]!;
  expect(resolveAggregatedLimit(min, 'output')).toBe(64_000);

  const max = (await resolveEnabledModels(fakeState([missing, present], ModelContextAggregation.Max)))[0]!;
  expect(resolveAggregatedLimit(max, 'output')).toBe(64_000);
});

test('invalid upstream limits fall through without poisoning aggregation', async () => {
  await seedCatalog({ shared: modelsDevModel('shared', 'Fallback', { limit: { context: 128_000, output: 64_000 } }) });
  const providers = [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map(
    (output, index) =>
      ({
        id: `p${index}`,
        kind: ProviderKind.OAuth,
        enabled: true,
        alias: { shared: { model: `up-${index}`, preserve: false } },
        upstreamMetadata: { [`up-${index}`]: { limit: { output } } },
        model: { invoke: async function* () {} },
      }) as unknown as RuntimeProviderInstance,
  );

  const min = (await resolveEnabledModels(fakeState(providers, ModelContextAggregation.Min)))[0]!;
  expect(resolveAggregatedLimit(min, 'output')).toBe(64_000);

  const max = (await resolveEnabledModels(fakeState(providers, ModelContextAggregation.Max)))[0]!;
  expect(resolveAggregatedLimit(max, 'output')).toBe(64_000);
});

test('treats a malformed cached models.dev row as missing metadata', async () => {
  await fileCacheStorage.setItem('models-dev-providers', {
    openrouter: { models: { broken: { id: 'broken' } } },
  });
  const provider = slugProvider('p1', 'broken', 'upstream');

  const resolved = await resolveEnabledModels(fakeState([provider]));
  expect(resolved).toHaveLength(1);
  expect(resolved[0]?.slug).toBe('broken');
  expect(resolved[0]?.fallbackMetadata).toBeUndefined();
});

test('capability resolution preserves false and replaces arrays wholesale', async () => {
  await seedCatalog({
    shared: modelsDevModel('shared', 'Fallback', {
      reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      structured_output: true,
    }),
  });
  const provider = {
    id: 'p1',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { shared: { model: 'upstream', preserve: false } },
    configMetadata: {
      upstream: { capabilities: { structuredOutput: false, modalities: { input: [] } } },
    },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const capabilities = resolveModelCapabilities((await resolveEnabledModels(fakeState([provider])))[0]!);
  expect(capabilities?.structuredOutput).toBe(false);
  expect(capabilities?.modalities?.input).toEqual([]);
  expect(capabilities?.reasoningOptions).toEqual([{ type: 'effort', values: ['low', 'high'] }]);
});
