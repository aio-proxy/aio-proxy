import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clearModelsCache, fileCacheStorage, type getModels, type PluginLogSink } from '@aio-proxy/core';
import { type Config, ConfigSchema, type ModelMetadata } from '@aio-proxy/types';
import type { Model } from '@opencode-ai/models';

import { applyMetadataExtend } from './resolve-extend';

const originalHome = process.env.AIO_PROXY_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'aio-resolve-extend-'));
  process.env.AIO_PROXY_HOME = home;
  clearModelsCache();
});

afterEach(() => {
  rmSync(home, { force: true, recursive: true });
  if (originalHome === undefined) delete process.env.AIO_PROXY_HOME;
  else process.env.AIO_PROXY_HOME = originalHome;
  clearModelsCache();
});

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
    router: {
      models: Object.fromEntries(Object.entries(metadata).map(([slug, entry]) => [slug, { metadata: entry }])),
    },
    providers: {},
  });
}

function stubGetModels(catalog: Record<string, Model | undefined>): typeof getModels {
  return (async (ids: string[]) => {
    const result: Record<string, Model | undefined> = {};
    for (const id of ids) result[id] = catalog[id];
    return result;
  }) as unknown as typeof getModels;
}

function metadataOf(config: Config, slug: string): ModelMetadata {
  const metadata = config.router.models[slug]?.metadata;
  if (metadata === undefined) throw new Error('expected router model metadata');
  return metadata;
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
      expect(metadataOf(result, 'my-gpt')).toMatchObject({ extend: 'openai/gpt-5.5', name: 'Kept' });
    } finally {
      globalThis.fetch = nativeFetch;
    }
  });

  it('keeps extend when a warm catalog lacks its target', async () => {
    await fileCacheStorage.setItem('models-dev-providers', { openai: { models: {} } });
    const config = makeConfig({ 'my-gpt': { extend: 'openai/missing', name: 'Kept' } });

    const resolved = await applyMetadataExtend(config);

    expect(metadataOf(resolved, 'my-gpt')).toEqual({ extend: 'openai/missing', name: 'Kept' });
  });

  it('materializes metadata.extend for a router model', async () => {
    const config = ConfigSchema.parse({
      router: {
        models: {
          model: {
            metadata: { extend: 'openai/gpt-5.5', name: 'Configured Name' },
          },
        },
      },
      providers: {},
    });
    const resolved = await applyMetadataExtend(config, undefined, {
      getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
    });

    expect(resolved.router.models.model?.metadata).toMatchObject({
      name: 'Configured Name',
      limit: { context: 400_000, input: 300_000, output: 128_000 },
    });
    expect(resolved.router.models.model?.metadata?.extend).toBeUndefined();
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
    const entry = metadataOf(resolved, 'my-gpt');

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
    const entry = metadataOf(resolved, 'openai/gpt-5.5');

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
    const entry = metadataOf(resolved, 'my-gpt');

    expect(entry.extend).toBeUndefined();
    expect(entry.name).toBe('Kept');
    expect(entry.cost).toEqual({ input: 3 });
    expect(logger).toHaveBeenCalledTimes(1);
    const call = logger.mock.calls[0]?.[0];
    expect(call?.context).toEqual({ model: 'my-gpt' });
    expect(call?.error.message).toContain('openai/missing');
    expect(call?.error.message).toContain('my-gpt');
  });

  it('preserves user fields when the catalog fetch fails', async () => {
    const config = makeConfig({
      'my-gpt': { extend: 'openai/gpt-5.5', name: 'Kept', cost: { input: 3 } },
    });
    const getModels = (async () => {
      throw new Error('catalog unavailable');
    }) as typeof import('@aio-proxy/core').getModels;

    const resolved = await applyMetadataExtend(config, undefined, { getModels });

    expect(metadataOf(resolved, 'my-gpt')).toEqual({ name: 'Kept', cost: { input: 3 } });
  });

  it('ignores inheritance when merged limits would be invalid', async () => {
    const config = makeConfig({
      'my-gpt': { extend: 'openai/gpt-5.5', name: 'Kept', limit: { input: 500_000 } },
    });
    const logger = mock<PluginLogSink>(() => {});

    const resolved = await applyMetadataExtend(config, logger, {
      getModels: stubGetModels({ 'openai/gpt-5.5': catalogModel() }),
    });
    const entry = metadataOf(resolved, 'my-gpt');

    expect(entry).toEqual({ name: 'Kept', limit: { input: 500_000 } });
    expect(logger.mock.calls[0]?.[0]).toMatchObject({
      event: 'metadata.extend.invalid',
      code: 'PROVIDER_CONFIG_INVALID',
      context: { model: 'my-gpt' },
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
