import { describe, expect, test } from 'bun:test';

import { ConfigSchema } from '..';
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

  test('parses router model metadata with per-provider cost and limit overrides', () => {
    const config = ConfigSchema.parse({
      router: {
        models: {
          'gpt-5': {
            metadata: { name: 'GPT-5', extend: 'openai/gpt-5', cost: { input: 1.25 } },
            providers: {
              reseller: { priority: 10, cost: { input: 0.8 }, limit: { context: 128_000 } },
            },
          },
        },
      },
      providers: {},
    });
    const policy = config.router.models['gpt-5'];
    expect(policy).toBeDefined();
    if (!policy) throw new Error('expected gpt-5 router model policy');
    expect(policy.metadata?.name).toBe('GPT-5');
    expect(policy.providers['reseller']?.cost).toEqual({ input: 0.8 });
    expect(policy.providers['reseller']?.limit).toEqual({ context: 128_000 });
  });

  test('silently strips the removed provider-level metadata field', () => {
    const config = ConfigSchema.parse({
      providers: {
        openai: { ...apiProvider, metadata: { 'gpt-5': { name: 'x' } } },
      },
    });
    const [provider] = config.providers;
    expect(provider).toBeDefined();
    if (!provider) throw new Error('expected parsed provider');
    expect('metadata' in provider).toBe(false);
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
});
