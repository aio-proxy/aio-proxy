import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';
import { ProviderKind } from '@aio-proxy/types';
import type { ModelContextAggregation } from '@aio-proxy/types';

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

test('projects config capability and limit.output overrides, and max_input distinct from context', async () => {
  // catalog: structured_output true, output 8k, input 500k, context 128k
  await seedCatalog({
    'gpt-x': modelsDevModel('gpt-x', 'gpt-x', {
      structured_output: true,
      limit: { context: 128_000, input: 500_000, output: 8_000 },
    }),
  });
  // config overrides: structuredOutput false, limit.output 4k, limit.input 272k
  const provider = {
    id: 'p1',
    kind: ProviderKind.Api,
    enabled: true,
    alias: { 'gpt-x': { model: 'up-x', preserve: false } },
    metadata: {
      'up-x': { capabilities: { structuredOutput: false }, limit: { input: 272_000, output: 4_000 } },
    },
    model: { invoke: async function* () {} },
  } as unknown as RuntimeProviderInstance;

  const result = await listModels(fakeState([provider]));
  const item = result.data[0]!;
  expect(item.capabilities?.structured_outputs).toEqual({ supported: false });
  expect(item.max_tokens).toBe(4_000); // config limit.output wins
  expect(item.max_input_tokens).toBe(272_000); // config limit.input, NOT context 128k or catalog 500k
});
