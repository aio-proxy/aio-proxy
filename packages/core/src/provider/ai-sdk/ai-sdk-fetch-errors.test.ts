import { describe, expect, test } from 'bun:test';

import type { LanguageModelV2, ProviderV3 } from '@ai-sdk/provider';
import { ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkProviderLoadOptions, ProviderFetch } from '../../index';
import { createAiSdkProvider } from '../../index';
import { collect, messages } from './ai-sdk-test-helpers';

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

describe('createAiSdkProvider', () => {
  const availableProvider = {
    languageModel() {
      throw new Error('languageModel should not be called by ensureAvailable');
    },
  } satisfies Pick<ProviderV3, 'languageModel'>;

  test('leaves non-OpenAI package fetch identity unchanged', async () => {
    const providerFetch = (async () => new Response('ok')) as ProviderFetch;
    let optionsSeen: AiSdkProviderLoadOptions | undefined;
    const provider = createAiSdkProvider(
      { kind: 'ai-sdk', id: 'anthropic', packageName: '@ai-sdk/anthropic', options: { apiKey: 'test' } },
      {
        fetch: providerFetch,
        async loadProvider(_packageName, options) {
          optionsSeen = options;
          return availableProvider;
        },
      },
    );

    await provider.ensureAvailable?.();
    expect(optionsSeen?.fetch).toBe(providerFetch);
  });

  test('Given uninstalled ai-sdk package When invoked Then request fails with install hint', async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: 'ai-sdk',
        id: 'missing-provider',
        packageName: '@vendor/missing-provider',
        models: ['missing-model'],
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );

    // When / Then
    await expect(collect(provider.invoke({ messages, modelId: 'missing-model' }))).rejects.toThrow(
      'run aio-proxy plugin add @vendor/missing-provider',
    );
  });

  test('wraps model stream failures with the provider id', async () => {
    const model = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('doGenerate should not be called');
      },
      async doStream() {
        throw new Error('upstream exploded');
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: 'ai-sdk',
        id: 'mock-ai-sdk',
        packageName: '@ai-sdk/openai',
        models: ['mock-model'],
      },
      { resolveModel: () => model },
    );

    await expect(collect(provider.invoke({ messages, modelId: 'mock-model' }))).rejects.toThrow(
      /mock-ai-sdk.*upstream exploded/,
    );
  });
});

test.each([
  ['@ai-sdk/openai', ProviderProtocol.OpenAIResponse],
  ['@ai-sdk/openai-compatible', ProviderProtocol.OpenAICompatible],
  ['@ai-sdk/anthropic', ProviderProtocol.Anthropic],
  ['@ai-sdk/google', ProviderProtocol.Gemini],
  ['@vendor/unknown', undefined],
] as const)('publishes the image target for %s', (packageName, targetProtocol) => {
  const provider = createAiSdkProvider({
    kind: 'ai-sdk',
    id: packageName,
    packageName,
  });

  expect(provider.targetProtocol).toBe(targetProtocol);
});
