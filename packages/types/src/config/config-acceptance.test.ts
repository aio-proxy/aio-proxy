import { describe, expect, test } from 'bun:test';

import { ConfigSchema, ProviderMutationBodySchema } from '..';
import { apiProvider, defaultRouter, defaultServer, providers } from './config-acceptance.test-support';

describe('ConfigSchema', () => {
  test('accepts api provider config', () => {
    expect(ConfigSchema.parse(providers({ openai: apiProvider }))).toEqual({
      plugins: [],
      server: defaultServer,
      router: defaultRouter,
      providers: [{ ...apiProvider, enabled: true, id: 'openai' }],
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
      providers: [{ ...provider, enabled: true, id: 'openai' }],
      invalidProviders: [],
    });
  });

  test('accepts disabled provider config', () => {
    expect(ConfigSchema.parse(providers({ openai: { ...apiProvider, enabled: false } }))).toEqual({
      plugins: [],
      server: defaultServer,
      router: defaultRouter,
      providers: [{ ...apiProvider, enabled: false, id: 'openai' }],
      invalidProviders: [],
    });
  });

  test('sorts providers by descending weight and preserves key order for ties', () => {
    const config = ConfigSchema.parse(
      providers({
        first: { ...apiProvider, weight: 10 },
        second: { ...apiProvider, weight: 20 },
        third: { ...apiProvider, weight: 10 },
      }),
    );

    expect(config.providers.map((provider) => provider.id)).toEqual(['second', 'first', 'third']);
    expect(config.providers.map((provider) => provider.weight)).toEqual([20, 10, 10]);
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
