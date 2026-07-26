import { describe, expect, test } from 'bun:test';

import type { ProviderFetch } from '@aio-proxy/core';
import { ConfigSchema, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { materializeProviders } from './materialize';
import { stubAiSdkInstance, stubApiInstance } from './proxy.test-support';

describe('materializeProviders proxy failures', () => {
  test('a rejecting proxy fetch surfaces one rejection and is never retried without the proxy', async () => {
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
    const rejection = new Error('proxy unreachable');
    let calls = 0;
    const rejectingFetch = (async () => {
      calls += 1;
      throw rejection;
    }) as ProviderFetch;
    let capturedFetch: ProviderFetch | undefined;

    materializeProviders(config, {
      createProxyFetch: () => rejectingFetch,
      createApiProvider: (provider, options) => {
        capturedFetch = options?.fetch;
        return stubApiInstance(provider.id);
      },
      bridgeApiProvider: (provider) => stubAiSdkInstance(`${provider.id}:bridge`),
    });

    await expect(capturedFetch?.('https://api.example.com')).rejects.toBe(rejection);
    expect(calls).toBe(1);
  });
});
