import { describe, expect, it } from 'bun:test';

import type { getModels } from '@aio-proxy/core';
import { type Config, ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import type { Model } from '@opencode-ai/models';

import { applyMetadataExtend } from './resolve-extend';

// A catalog base with values distinct from anything the user sets, so an
// inherited value surfacing downstream is unambiguous evidence of the chain.
function catalogModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gpt-5.5',
    name: 'GPT-5.5 (catalog)',
    description: 'Catalog description.',
    attachment: true,
    reasoning: true,
    tool_call: true,
    structured_output: true,
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    limit: { context: 400_000, input: 300_000, output: 128_000 },
    cost: { input: 1.25, output: 10 },
    ...overrides,
  };
}

function stubGetModels(catalog: Record<string, Model | undefined>): typeof getModels {
  return (async (ids: string[]) => {
    const result: Record<string, Model | undefined> = {};
    for (const id of ids) result[id] = catalog[id];
    return result;
  }) as unknown as typeof getModels;
}

function makeConfig(modelId: string, metadata: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    router: {
      models: {
        [modelId]: { metadata },
      },
    },
    providers: {
      p1: {
        kind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: 'https://api.example.com',
        models: [modelId],
      },
    },
  });
}

describe('metadata.extend end-to-end wiring', () => {
  const modelId = 'my-gpt';

  // The user overrides `name` and `cost.input` but leaves `limit` and
  // `cost.output` to be inherited from the extend target's catalog entry.
  async function resolveMetadata() {
    const config = makeConfig(modelId, {
      extend: 'openai/gpt-5.5',
      name: 'My Aliased GPT',
      cost: { input: 2 },
    });
    const resolved = await applyMetadataExtend(config, undefined, {
      getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
    });
    return resolved.router.models[modelId]?.metadata;
  }

  it('surfaces inherited name/limit on the router model policy', async () => {
    const entry = await resolveMetadata();

    // User field wins (name) — proves the merge preserved the explicit override.
    expect(entry?.name).toBe('My Aliased GPT');
    // limit is inherited wholesale from the catalog base.
    expect(entry?.limit?.context).toBe(400_000);
  });

  it('surfaces merged cost on the router model policy', async () => {
    const entry = await resolveMetadata();

    // User override survives...
    expect(entry?.cost?.input).toBe(2);
    // ...and the inherited catalog cost.output (never set by the user) is present.
    expect(entry?.cost?.output).toBe(10);
  });
});
