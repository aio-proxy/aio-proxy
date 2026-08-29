import { expect, test } from 'bun:test';

import { ConfigSchema, type Provider, ProviderKind } from '@aio-proxy/types';

import type { RuntimeProviderInstance } from '../../runtime';
import { attachImageTransport } from './materialize-image';

const IMAGE_OUT = { capabilities: { modalities: { output: ['image' as const] } } };

function openAiCompatibleApiConfig(): Provider {
  const config = ConfigSchema.parse({
    providers: {
      api: {
        kind: 'api',
        protocol: 'openai-compatible',
        baseURL: 'https://api.example.com',
        models: ['gpt-5'],
      },
    },
  });
  return config.providers[0]!;
}

function languageOnlyInstance(): RuntimeProviderInstance {
  return {
    id: 'api',
    kind: ProviderKind.Api,
    enabled: true,
    capabilityIndex: { 'gpt-5': new Set(['language'] as const) },
    raw: { resolve: () => undefined },
  };
}

test('a router image-output policy attaches the image transport even when no catalog model is image-capable', () => {
  const instance = attachImageTransport(languageOnlyInstance(), {
    config: openAiCompatibleApiConfig(),
    routerModels: { pub: { metadata: IMAGE_OUT, providers: {} } },
  });
  expect(instance.image).toBeDefined();
});

test('router policies without image output do not attach an image transport', () => {
  const instance = attachImageTransport(languageOnlyInstance(), {
    config: openAiCompatibleApiConfig(),
    routerModels: { pub: { metadata: { name: 'Text' }, providers: {} } },
  });
  expect(instance.image).toBeUndefined();
});

test('an image-capable index still attaches the transport without router policies', () => {
  const instance = attachImageTransport(
    {
      ...languageOnlyInstance(),
      capabilityIndex: { 'gpt-image-2': new Set(['image'] as const) },
    },
    { config: openAiCompatibleApiConfig() },
  );
  expect(instance.image).toBeDefined();
});
