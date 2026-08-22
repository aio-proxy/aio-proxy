import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, Router, type ModelsDevModel } from '@aio-proxy/core';
import { ModelContextAggregation, ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import type { ServerState } from '../../server-state';
import { listModels } from './list-models';

// Metadata resolves through models.dev (fileCacheStorage keyed off AIO_PROXY_HOME).
// Seed the provider map on an isolated home so each case controls exactly which
// slug carries metadata. (Harness copied from model-resolution.test.ts.)
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
  home = mkdtempSync(join(tmpdir(), 'list-models-'));
  process.env.AIO_PROXY_HOME = home;
  clearModelsCache();
});

afterEach(() => {
  clearModelsCache();
  rmSync(home, { recursive: true, force: true });
  if (original === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = original;
});

async function seedCatalog(models: Record<string, ModelsDevModel>): Promise<void> {
  const providerModels: Record<string, Record<string, ModelsDevModel>> = {
    anthropic: {},
    google: {},
    openai: {},
    openrouter: {},
  };
  const prefixProvider = (slug: string): string => {
    if (slug.startsWith('claude-')) return 'anthropic';
    if (slug.startsWith('gemini-')) return 'google';
    if (slug.startsWith('gpt-')) return 'openai';
    return 'openrouter';
  };
  for (const [slug, model] of Object.entries(models)) {
    providerModels.openrouter[slug] = model;
    providerModels[prefixProvider(slug)][slug] = model;
  }
  const providers = Object.fromEntries(Object.entries(providerModels).map(([id, models]) => [id, { models }]));
  await fileCacheStorage.setItem('models-dev-providers', providers);
}

function fakeState(
  providers: readonly RuntimeProviderInstance[],
  aggregation?: (typeof ModelContextAggregation)[keyof typeof ModelContextAggregation],
): ServerState {
  const config = aggregation === undefined ? undefined : { router: { modelContextAggregation: aggregation } };
  return {
    acquireProviderSnapshot: () => ({
      snapshot: {
        providers,
        router: new Router(providers, { models: config?.router.models }),
        ...(config === undefined ? {} : { config }),
      },
      release() {},
    }),
  } as unknown as ServerState;
}

test('projects composite metadata fields from their resolved sources', async () => {
  await seedCatalog({
    'gpt-x': modelsDevModel('gpt-x', 'Fallback Name', {
      release_date: '1970-01-04',
      structured_output: true,
      limit: { context: 1_050_000, input: 922_000, output: 64_000 },
    }),
  });
  const provider = {
    id: 'p1',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { 'gpt-x': { model: 'up-x', preserve: false } },
    configMetadata: {
      'up-x': {
        name: 'Configured Name',
        capabilities: { releaseDate: '1970-01-02', structuredOutput: false },
        limit: { context: 400_000, input: 272_000, output: 128_000 },
      },
    },
    upstreamMetadata: {
      'up-x': { capabilities: { releaseDate: '1970-01-03' } },
    },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const result = await listModels(fakeState([provider]));
  const item = result.data[0]!;
  expect(item.capabilities?.structured_outputs).toEqual({ supported: false });
  expect(item.max_input_tokens).toBe(272_000);
  expect(item.max_tokens).toBe(128_000);
  expect(item.display_name).toBe('Configured Name');
  expect(item.created).toBe(86_400);
  expect(item.created_at).toBe('1970-01-02T00:00:00.000Z');
});

test('max_tokens follows the configured aggregation across candidates', async () => {
  await seedCatalog({});
  const provider = (id: string, model: string, output: number) =>
    ({
      id,
      kind: ProviderKind.Api,
      enabled: true,
      alias: { shared: { model, preserve: false } },
      configMetadata: { [model]: { limit: { output } } },
      model: { invoke: async function* () {} },
    }) as unknown as RuntimeProviderInstance;
  const candidates = [provider('p1', 'up-first', 128_000), provider('p2', 'up-second', 64_000)];

  expect((await listModels(fakeState(candidates, ModelContextAggregation.Min))).data[0]?.max_tokens).toBe(64_000);
  expect((await listModels(fakeState(candidates, ModelContextAggregation.Max))).data[0]?.max_tokens).toBe(128_000);
});
