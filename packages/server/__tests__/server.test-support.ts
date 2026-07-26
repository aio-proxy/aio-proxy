import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type ModelsDevModel } from '@aio-proxy/core';
import { ProviderProtocol } from '@aio-proxy/types';

export const config = {
  providers: {
    'openai-compatible': {
      kind: 'api',
      protocol: ProviderProtocol.OpenAICompatible,
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
      baseURL: 'https://api.example.com',
      models: ['gpt-test'],
      alias: {
        'gpt-alias': { model: 'gpt-test', preserve: true },
      },
    },
    compatible: {
      kind: 'ai-sdk',
      packageName: '@ai-sdk/openai-compatible',
      options: {
        apiKey: 'Bearer super-secret-token',
        baseURL: 'https://compatible.example.com',
        headers: {
          authorization: 'Token provider-secret',
          'x-api-key': 'header-secret',
        },
        name: 'compatible',
      },
      models: ['compatible', 'compatible-test'],
      alias: {
        compatible: { model: 'compatible-test', preserve: false },
      },
    },
  },
};

// The models.dev catalog now resolves through fileCacheStorage (keyed off
// AIO_PROXY_HOME) and a process-wide LRU rather than an injected task. Seed
// helpers point that catalog at an isolated home so a test controls exactly
// which model metadata /v1/models sees, and clean up the home plus caches
// afterwards.
const originalAioHome = process.env.AIO_PROXY_HOME;
let seededHome: string | undefined;

function useIsolatedCatalogHome(): void {
  seededHome = mkdtempSync(join(tmpdir(), 'aio-proxy-catalog-'));
  process.env.AIO_PROXY_HOME = seededHome;
  clearModelsCache();
}

// Reset the catalog home and caches. Pair every seed call with this in afterEach.
export function clearModelsDevCatalog(): void {
  clearModelsCache();
  if (seededHome !== undefined) {
    rmSync(seededHome, { force: true, recursive: true });
    seededHome = undefined;
  }
  if (originalAioHome === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = originalAioHome;
}

// Point the catalog at an empty OpenRouter map: every model resolves to no
// metadata, the replacement for the old `noModelsDevCatalog` task.
export async function seedEmptyModelsDevCatalog(): Promise<void> {
  useIsolatedCatalogHome();
  await fileCacheStorage.setItem('models-dev-providers', { openrouter: { models: {} } });
}

// Seed catalog metadata keyed by the alias slug callers query. Each record is
// placed under both OpenRouter and, for prefixed slugs, its pinned provider, so
// getModels resolves it regardless of which lookup branch the slug takes.
export async function seedModelsDevCatalog(models: Record<string, ModelsDevModel>): Promise<void> {
  useIsolatedCatalogHome();
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

// A models.dev record double. Overrides let each test tweak just the fields it
// exercises; the server derives the Anthropic capabilities shape from this raw
// Model at the /v1/models boundary.
export const modelsDevModel = (id: string, name: string, overrides: Partial<ModelsDevModel> = {}): ModelsDevModel => ({
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

// The capability signals shared by the /v1/models capabilities test.
export const testCapabilitySignals: Partial<ModelsDevModel> = {
  reasoning: true,
  reasoning_options: [
    { type: 'effort', values: ['low', 'medium', 'high'] },
    { type: 'budget_tokens', min: 1_024 },
  ],
  modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  structured_output: true,
};

// The Anthropic capabilities shape the server is expected to emit for the row above.
// The capabilities shape derived from a default text-only, non-reasoning Model
// (modelsDevModel with no overrides). Every capability is unsupported.
export const textOnlyCapabilities = {
  effort: {
    high: { supported: false },
    low: { supported: false },
    max: { supported: false },
    medium: { supported: false },
    supported: false,
    xhigh: { supported: false },
  },
  image_input: { supported: false },
  pdf_input: { supported: false },
  structured_outputs: { supported: false },
  thinking: {
    supported: false,
    types: { adaptive: { supported: false }, enabled: { supported: false } },
  },
};

export const testCapabilities = {
  effort: {
    high: { supported: true },
    low: { supported: true },
    max: { supported: false },
    medium: { supported: true },
    supported: true,
    xhigh: { supported: false },
  },
  image_input: { supported: true },
  pdf_input: { supported: true },
  structured_outputs: { supported: true },
  thinking: {
    supported: true,
    types: { adaptive: { supported: true }, enabled: { supported: true } },
  },
};

type ExpectedModelMetadata = {
  readonly capabilities?: typeof testCapabilities | typeof textOnlyCapabilities;
  readonly created?: number;
  readonly createdAt?: string;
  readonly maxInputTokens?: number;
  readonly maxTokens?: number;
};

export const expectedModel = (
  id: string,
  ownedBy: string,
  displayName: string = id,
  metadata: ExpectedModelMetadata = {},
) => ({
  capabilities: metadata.capabilities ?? null,
  created: metadata.created ?? 0,
  created_at: metadata.createdAt ?? '1970-01-01T00:00:00Z',
  display_name: displayName,
  id,
  max_input_tokens: metadata.maxInputTokens ?? null,
  max_tokens: metadata.maxTokens ?? null,
  object: 'model',
  owned_by: ownedBy,
  type: 'model',
});

export const expectedModelList = (data: ReturnType<typeof expectedModel>[]) => ({
  data,
  first_id: data[0]?.id ?? null,
  has_more: false,
  last_id: data.at(-1)?.id ?? null,
  object: 'list',
});
