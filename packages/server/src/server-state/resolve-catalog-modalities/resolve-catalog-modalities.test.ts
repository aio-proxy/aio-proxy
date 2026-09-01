import { describe, expect, test } from 'bun:test';

import type { getModels } from '@aio-proxy/core';
import { type Config, ConfigSchema } from '@aio-proxy/types';
import type { Model } from '@opencode-ai/models';

import { resolveCatalogModalities } from './resolve-catalog-modalities';

function catalogModel(id: string, output: Model['modalities']['output']): Model {
  return {
    id,
    name: id,
    attachment: false,
    reasoning: false,
    tool_call: false,
    modalities: { input: ['text'], output },
    open_weights: false,
    limit: { context: 128_000, output: 4096 },
    cost: { input: 1, output: 2 },
  } as Model;
}

const CATALOG: Record<string, Model | undefined> = {
  'gpt-image-2': catalogModel('gpt-image-2', ['image']),
  'gpt-5': catalogModel('gpt-5', ['text']),
  'alias-image': catalogModel('alias-image', ['image']),
  // Missing `modalities` entirely: a malformed entry must not fail the other ids.
  broken: { id: 'broken' } as Model,
};

function stubGetModels(): typeof getModels {
  return (async (ids: string[]) =>
    Object.fromEntries(ids.map((id) => [id, CATALOG[id]]))) as unknown as typeof getModels;
}

function makeConfig(providers: Record<string, unknown>, routerModels: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({ providers, router: { models: routerModels } });
}

function outputOf(
  resolved: Record<string, { capabilities?: { modalities?: { output?: readonly string[] } } }>,
  id: string,
) {
  return resolved[id]?.capabilities?.modalities?.output;
}

describe('resolveCatalogModalities', () => {
  test('resolves output modalities for ids reachable via models and alias', async () => {
    const config = makeConfig({
      carpool: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example.com',
        models: ['gpt-image-2', 'gpt-5', 'broken'],
      },
      // No `models` whitelist, so `alias-image` is reachable only through the alias.
      aliased: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://alias.example.com',
        alias: { pretty: { model: 'alias-image' } },
      },
    });

    const resolved = await resolveCatalogModalities(config, { getModels: stubGetModels() });

    expect(outputOf(resolved, 'gpt-image-2')).toEqual(['image']);
    expect(outputOf(resolved, 'alias-image')).toEqual(['image']);
    expect(outputOf(resolved, 'gpt-5')).toEqual(['text']);
    expect(resolved['broken']).toBeUndefined();
  });

  test('skips ids whose router policy already authors an output modality', async () => {
    const config = makeConfig(
      {
        carpool: {
          kind: 'api',
          protocol: 'openai-response',
          baseURL: 'https://api.example.com',
          models: ['gpt-image-2'],
        },
      },
      { 'gpt-image-2': { metadata: { capabilities: { modalities: { output: ['text'] } } } } },
    );

    const resolved = await resolveCatalogModalities(config, { getModels: stubGetModels() });

    expect(resolved['gpt-image-2']).toBeUndefined();
  });

  test('ignores OAuth providers, whose catalog already declares image models', async () => {
    const config = makeConfig({
      person: { kind: 'oauth', plugin: '@example/oauth', capability: 'default', models: ['gpt-image-2'] },
    });

    const resolved = await resolveCatalogModalities(config, { getModels: stubGetModels() });

    expect(resolved).toEqual({});
  });

  test('treats a catalog fetch failure as no fallback rather than failing the snapshot', async () => {
    const config = makeConfig({
      carpool: {
        kind: 'api',
        protocol: 'openai-response',
        baseURL: 'https://api.example.com',
        models: ['gpt-image-2'],
      },
    });

    const resolved = await resolveCatalogModalities(config, {
      getModels: (async () => {
        throw new Error('offline');
      }) as unknown as typeof getModels,
    });

    expect(resolved).toEqual({});
  });
});
