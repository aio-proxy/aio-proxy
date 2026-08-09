import { describe, expect, it, mock } from 'bun:test';

import { clearModelsCache, fileCacheStorage, type getModels, type PluginLogSink } from '@aio-proxy/core';
import { type Config, ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import type { Model } from '@opencode-ai/models';

import { applyMetadataExtend } from './resolve-extend';

// A representative catalog model. Distinct values so a mis-mapping surfaces as a
// wrong number, and reasoning_options present so array-replace can be verified.
function catalogModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'gpt-5.5',
    name: 'GPT-5.5 (catalog)',
    description: 'Catalog description.',
    attachment: true,
    reasoning: true,
    reasoning_options: [{ type: 'toggle' }],
    tool_call: true,
    structured_output: true,
    modalities: { input: ['text'], output: ['text'] },
    open_weights: false,
    limit: { context: 400_000, input: 300_000, output: 128_000 },
    cost: { input: 1.25, output: 10 },
    ...overrides,
  };
}

function makeConfig(metadata: Record<string, unknown>): Config {
  return ConfigSchema.parse({
    providers: {
      p1: {
        kind: ProviderKind.Api,
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: 'https://api.example.com',
        models: Object.keys(metadata),
        metadata,
      },
    },
  });
}

function stubGetModels(catalog: Record<string, Model | undefined>): typeof getModels {
  return (async (ids: string[]) => {
    const result: Record<string, Model | undefined> = {};
    for (const id of ids) result[id] = catalog[id];
    return result;
  }) as unknown as typeof getModels;
}

function metadataOf(config: Config, providerId: string): Record<string, unknown> {
  const provider = config.providers.find((candidate) => candidate.id === providerId);
  if (provider === undefined || !('metadata' in provider) || provider.metadata === undefined) {
    throw new Error('expected provider metadata');
  }
  return provider.metadata as Record<string, unknown>;
}

describe('applyMetadataExtend', () => {
  it('does not wait for the network when the catalog cache is cold', async () => {
    const config = makeConfig({
      'my-gpt': { extend: 'openai/gpt-5.5', name: 'Kept' },
    });
    const nativeFetch = globalThis.fetch;
    const timedOut = Symbol('timed out');

    clearModelsCache();
    await fileCacheStorage.removeItem('models-dev-providers');
    globalThis.fetch = (() => new Promise<Response>(() => {})) as typeof fetch;

    try {
      const result = await Promise.race([applyMetadataExtend(config), Bun.sleep(500).then(() => timedOut)]);

      expect(result).not.toBe(timedOut);
      if (result === timedOut) throw new Error('metadata resolution waited for the catalog');
      expect(metadataOf(result, 'p1')['my-gpt']).toMatchObject({ extend: 'openai/gpt-5.5', name: 'Kept' });
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  it('materializes metadata.extend for an OAuth Provider', async () => {
    const config = ConfigSchema.parse({
      providers: {
        person: {
          kind: 'oauth',
          plugin: '@example/oauth',
          capability: 'default',
          metadata: { model: { extend: 'openai/gpt-5.5', name: 'Configured OAuth Name' } },
        },
      },
    });
    const resolved = await applyMetadataExtend(config, undefined, {
      getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
    });
    const provider = resolved.providers[0];
    if (provider?.kind !== ProviderKind.OAuth) throw new Error('expected OAuth Provider');

    expect(provider.metadata?.model).toMatchObject({
      name: 'Configured OAuth Name',
      limit: { context: 400_000, input: 300_000, output: 128_000 },
    });
    expect(provider.metadata?.model.extend).toBeUndefined();
  });

  it('two-layer merges catalog base under user fields with array replacement', async () => {
    const config = makeConfig({
      'my-gpt': {
        extend: 'openai/gpt-5.5',
        name: 'My GPT',
        cost: { input: 2 },
        capabilities: { reasoningOptions: [{ type: 'effort', values: ['high'] }] },
      },
    });
    const deps = { getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }) };

    const resolved = await applyMetadataExtend(config, undefined, deps);
    const entry = metadataOf(resolved, 'p1')['my-gpt'] as Record<string, any>;

    expect(entry.extend).toBeUndefined();
    // user wins on scalar
    expect(entry.name).toBe('My GPT');
    // user cost.input override; inherited cost.output survives (object deep-merge)
    expect(entry.cost.input).toBe(2);
    expect(entry.cost.output).toBe(10);
    // arrays replace wholesale, not index-merge
    expect(entry.capabilities.reasoningOptions).toEqual([{ type: 'effort', values: ['high'] }]);
    // inherited-only fields present from the base layer
    expect(entry.limit).toEqual({ context: 400_000, input: 300_000, output: 128_000 });
    expect(entry.description).toBe('Catalog description.');
  });

  it('bases only on the extend target, never the model id own catalog entry', async () => {
    const config = makeConfig({
      'openai/gpt-5.5': { extend: 'openai/other', name: 'Aliased' },
    });
    const deps = {
      getModels: stubGetModels({
        // Would resolve if the model id itself were auto-matched — it must NOT be.
        'openai/gpt-5.5': catalogModel({ name: 'SELF SHOULD NOT WIN', cost: { input: 999, output: 999 } }),
        'openai/other': catalogModel({ name: 'Other Base', cost: { input: 7, output: 8 } }),
      }),
    };

    const resolved = await applyMetadataExtend(config, undefined, deps);
    const entry = metadataOf(resolved, 'p1')['openai/gpt-5.5'] as Record<string, any>;

    expect(entry.name).toBe('Aliased');
    expect(entry.cost).toEqual({ input: 7, output: 8 });
  });

  it('preserves user fields, strips extend, and warns when the target is unresolved', async () => {
    const config = makeConfig({
      'my-gpt': { extend: 'openai/missing', name: 'Kept', cost: { input: 3 } },
    });
    const logger = mock<PluginLogSink>(() => {});
    const deps = { getModels: stubGetModels({}) };

    const resolved = await applyMetadataExtend(config, logger, deps);
    const entry = metadataOf(resolved, 'p1')['my-gpt'] as Record<string, any>;

    expect(entry.extend).toBeUndefined();
    expect(entry.name).toBe('Kept');
    expect(entry.cost).toEqual({ input: 3 });
    expect(logger).toHaveBeenCalledTimes(1);
    const call = logger.mock.calls[0]?.[0];
    expect(call?.context.providerId).toBe('p1');
    expect(call?.error.message).toContain('openai/missing');
    expect(call?.error.message).toContain('my-gpt');
  });

  it('ignores inheritance when merged limits would be invalid', async () => {
    const config = makeConfig({
      'my-gpt': { extend: 'openai/gpt-5.5', name: 'Kept', limit: { input: 500_000 } },
    });
    const logger = mock<PluginLogSink>(() => {});

    const resolved = await applyMetadataExtend(config, logger, {
      getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
    });
    const entry = metadataOf(resolved, 'p1')['my-gpt'];

    expect(entry).toEqual({ name: 'Kept', limit: { input: 500_000 } });
    expect(logger.mock.calls[0]?.[0]).toMatchObject({
      event: 'metadata.extend.invalid',
      code: 'PROVIDER_CONFIG_INVALID',
      context: { providerId: 'p1' },
      error: { name: 'MetadataExtendInvalid' },
    });
  });

  it('passes entries without extend through untouched and skips the catalog fetch', async () => {
    const config = makeConfig({
      'plain-model': { name: 'Plain', cost: { input: 1 } },
    });
    const getModelsSpy = mock(stubGetModels({}));

    const resolved = await applyMetadataExtend(config, undefined, { getModels: getModelsSpy });

    // No extend anywhere → identical config object, no catalog lookup.
    expect(resolved).toBe(config);
    expect(getModelsSpy).not.toHaveBeenCalled();
  });
});
