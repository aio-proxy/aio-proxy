import { describe, expect, test } from 'bun:test';

import { ConfigSchema, ProviderMutationBodySchema } from '..';
import { apiProvider, defaultRouter, defaultServer, providers } from './config-acceptance.test-support';

describe('ConfigSchema', () => {
  test('accepts api provider config', () => {
    expect(ConfigSchema.parse(providers({ openai: apiProvider }))).toEqual({
      plugins: [],
      server: defaultServer,
      router: defaultRouter,
      providers: [{ ...apiProvider, enabled: true, id: 'openai', priority: 0, weight: 1 }],
      invalidProviders: [],
    });
  });

  test('accepts a provider proxy override and headers alongside an inherited top-level proxy', () => {
    const provider = {
      ...apiProvider,
      proxy: 'http://provider-proxy.example:8080',
      headers: { 'X-Tenant': 'team-a' },
    };

    expect(ConfigSchema.parse({ proxy: 'https://proxy.example:8443', providers: { openai: provider } })).toEqual({
      plugins: [],
      server: defaultServer,
      router: defaultRouter,
      proxy: 'https://proxy.example:8443',
      providers: [{ ...provider, enabled: true, id: 'openai', priority: 0, weight: 1 }],
      invalidProviders: [],
    });
  });

  test('accepts disabled provider config', () => {
    expect(ConfigSchema.parse(providers({ openai: { ...apiProvider, enabled: false } }))).toEqual({
      plugins: [],
      server: defaultServer,
      router: defaultRouter,
      providers: [{ ...apiProvider, enabled: false, id: 'openai', priority: 0, weight: 1 }],
      invalidProviders: [],
    });
  });

  test('normalizes Provider routing defaults while preserving authoring order', () => {
    const config = ConfigSchema.parse({
      providers: {
        first: { ...apiProvider, weight: 1.6 },
        second: { ...apiProvider, priority: 20, weight: 20_000 },
        third: { ...apiProvider, priority: -3, weight: -2 },
      },
    });

    expect(config.providers.map(({ id, priority, weight }) => ({ id, priority, weight }))).toEqual([
      { id: 'first', priority: 0, weight: 2 },
      { id: 'second', priority: 20, weight: 10_000 },
      { id: 'third', priority: 0, weight: 0 },
    ]);
  });

  test('parses sparse exact model policies without validating references', () => {
    const config = ConfigSchema.parse({
      router: {
        models: {
          'openai/gpt-5': {
            providers: {
              primary: { priority: 30 },
              missing: { weight: 0.6 },
            },
          },
        },
      },
      providers: { primary: apiProvider },
    });

    expect(config.router.models['openai/gpt-5']).toEqual({
      providers: { primary: { priority: 30 }, missing: { weight: 1 } },
    });
  });

  test('round-trips per-model metadata through the full config pipeline', () => {
    const provider = {
      ...apiProvider,
      metadata: { 'up-x': { limit: { context: 1000 }, cost: { input: 2 } } },
    };

    const config = ConfigSchema.parse(providers({ openai: provider }));

    const [parsed] = config.providers;
    expect(parsed?.metadata?.['up-x']?.limit?.context).toBe(1000);
    expect(parsed?.metadata?.['up-x']?.cost?.input).toBe(2);
  });
});

describe('ProviderMutationBodySchema', () => {
  test('preserves per-model metadata on a PUT-style api mutation body', () => {
    const parsed = ProviderMutationBodySchema.parse({
      kind: 'api',
      id: 'openai',
      protocol: 'openai-compatible',
      baseURL: 'https://api.example.com',
      metadata: { 'up-x': { limit: { context: 1000 }, cost: { input: 2 } } },
    });

    expect(parsed.kind).toBe('api');
    if (parsed.kind !== 'api') throw new Error('expected api mutation body');
    expect(parsed.metadata?.['up-x']?.limit?.context).toBe(1000);
    expect(parsed.metadata?.['up-x']?.cost?.input).toBe(2);
  });
});
