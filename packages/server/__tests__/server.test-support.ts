import type { ModelsDevModel } from '@aio-proxy/core';
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

export const noModelsDevCatalog = async () => undefined;

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
