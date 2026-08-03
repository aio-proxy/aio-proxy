import { describe, expect, it } from 'bun:test';

import type { getModels } from '@aio-proxy/core';
import { type Config, ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import type { Model } from '@opencode-ai/models';

import { materializeProviders } from '../../provider-runtime/materialize';
import { candidateConfigPrice } from '../../routes/pipeline/attempt-base';
import type { RuntimeProviderInstance } from '../../runtime';
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
    providers: {
      p1: {
        kind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: 'https://api.example.com',
        models: [modelId],
        metadata: { [modelId]: metadata },
      },
    },
  });
}

function runtimeProviderById(config: Config, id: string): RuntimeProviderInstance {
  const provider = materializeProviders(config).providers.find((candidate) => candidate.id === id);
  if (provider === undefined) throw new Error(`runtime provider '${id}' not materialized`);
  return provider;
}

describe('metadata.extend end-to-end wiring', () => {
  const modelId = 'my-gpt';

  // The user overrides `name` and `cost.input` but leaves `limit` and
  // `cost.output` to be inherited from the extend target's catalog entry.
  async function resolveAndMaterialize(): Promise<RuntimeProviderInstance> {
    const config = makeConfig(modelId, {
      extend: 'openai/gpt-5.5',
      name: 'My Aliased GPT',
      cost: { input: 2 },
    });
    const resolved = await applyMetadataExtend(config, undefined, {
      getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
    });
    return runtimeProviderById(resolved, 'p1');
  }

  it('surfaces inherited name/limit on the runtime provider for model-resolution to read', async () => {
    const provider = await resolveAndMaterialize();
    // model-resolution's resolveDisplayName / candidateContextWindow both read
    // provider.metadata[modelId].{name,limit}. These are private helpers, so we
    // assert on exactly the object they consume — this fails if extend→materialize
    // wiring stops delivering the merged metadata onto the runtime provider.
    const entry = provider.metadata?.[modelId];

    // User field wins (name) — proves the merge preserved the explicit override.
    expect(entry?.name).toBe('My Aliased GPT');
    // limit is inherited wholesale from the catalog base — proves the runtime
    // provider carries the inherited context window candidateContextWindow returns.
    expect(entry?.limit?.context).toBe(400_000);
  });

  it('feeds inherited cost into candidateConfigPrice so billing tags priceSource:config', async () => {
    const provider = await resolveAndMaterialize();
    // The billing consumer reads provider.metadata[modelId].cost via this exact
    // helper; a defined price with the INHERITED cost.output present proves the
    // extend-inherited cost reached billing (any config cost => priceSource:'config').
    const price = candidateConfigPrice(provider, modelId);

    expect(price).toBeDefined();
    expect(price?.id).toBe(modelId);
    // User override survives...
    expect(price?.input).toBe(2);
    // ...and the inherited catalog cost.output (never set by the user) is present.
    expect(price?.output).toBe(10);
  });
});
