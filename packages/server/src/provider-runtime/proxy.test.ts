import { describe, expect, test } from 'bun:test';

import type { ProviderFetch } from '@aio-proxy/core';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { materializeProviders } from './materialize';
import { stubAiSdkInstance, stubApiInstance } from './proxy.test-support';

describe('materializeProviders proxy resolution', () => {
  test('inherits the global proxy when an API provider omits its own', () => {
    const config = ConfigSchema.parse({
      proxy: 'http://global.proxy.example:8080',
      providers: {
        api: {
          baseURL: 'https://api.example.com',
          kind: ProviderKind.Api,
          models: ['model'],
          protocol: ProviderProtocol.OpenAICompatible,
        },
      },
    });
    const seenProxies: (string | undefined)[] = [];
    const capturedFetches: (ProviderFetch | undefined)[] = [];

    materializeProviders(config, {
      createProxyFetch: (proxy) => {
        seenProxies.push(proxy);
        return (async () => new Response()) as ProviderFetch;
      },
      createApiProvider: (provider, options) => {
        capturedFetches.push(options?.fetch);
        return stubApiInstance(provider.id);
      },
      bridgeApiProvider: (provider, options) => {
        capturedFetches.push(options?.fetch);
        return stubAiSdkInstance(`${provider.id}:bridge`);
      },
    });

    expect(seenProxies).toEqual(['http://global.proxy.example:8080']);
    expect(capturedFetches[0]).toBe(capturedFetches[1]);
  });

  test('prefers a provider-level proxy over the global proxy', () => {
    const config = ConfigSchema.parse({
      proxy: 'http://global.proxy.example:8080',
      providers: {
        api: {
          baseURL: 'https://api.example.com',
          kind: ProviderKind.Api,
          models: ['model'],
          protocol: ProviderProtocol.OpenAICompatible,
          proxy: 'http://provider.proxy.example:9090',
        },
      },
    });
    const seenProxies: (string | undefined)[] = [];

    materializeProviders(config, {
      createProxyFetch: (proxy) => {
        seenProxies.push(proxy);
        return (async () => new Response()) as ProviderFetch;
      },
      createApiProvider: (provider) => stubApiInstance(provider.id),
      bridgeApiProvider: (provider) => stubAiSdkInstance(`${provider.id}:bridge`),
    });

    expect(seenProxies).toEqual(['http://provider.proxy.example:9090']);
  });

  test('disables the inherited proxy when a provider sets proxy: false', () => {
    const config = ConfigSchema.parse({
      proxy: 'http://global.proxy.example:8080',
      providers: {
        aiSdk: {
          kind: ProviderKind.AiSdk,
          models: ['model'],
          packageName: '@ai-sdk/openai-compatible',
          proxy: false,
        },
      },
    });
    const seenProxies: (string | undefined)[] = [];

    materializeProviders(config, {
      createProxyFetch: (proxy) => {
        seenProxies.push(proxy);
        return (async () => new Response()) as ProviderFetch;
      },
      createAiSdkProvider: (provider) => stubAiSdkInstance(provider.id),
    });

    expect(seenProxies).toEqual([undefined]);
  });

  test('resolves no proxy when neither the provider nor the config configures one', () => {
    const config = ConfigSchema.parse({
      providers: {
        aiSdk: {
          kind: ProviderKind.AiSdk,
          models: ['model'],
          packageName: '@ai-sdk/openai-compatible',
        },
      },
    });
    const seenProxies: (string | undefined)[] = [];

    materializeProviders(config, {
      createProxyFetch: (proxy) => {
        seenProxies.push(proxy);
        return (async () => new Response()) as ProviderFetch;
      },
      createAiSdkProvider: (provider) => stubAiSdkInstance(provider.id),
    });

    expect(seenProxies).toEqual([undefined]);
  });
});
