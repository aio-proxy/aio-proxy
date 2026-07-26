import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkProviderLoadOptions } from '../../index';
import { bridgeApiProviderToAiSdk, createApiProvider } from '../../index';
import { loadedProvider, model } from './api-bridge-test-helpers';

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

describe('bridgeApiProviderToAiSdk', () => {
  test('Given materialized api provider When bridged Then retained metadata is used', async () => {
    // Given
    let packageSeen: string | undefined;
    let optionsSeen: AiSdkProviderLoadOptions | undefined;
    const provider = createApiProvider({
      kind: ProviderKind.Api,
      id: 'responses',
      protocol: ProviderProtocol.OpenAIResponse,
      apiKey: 'secret',
      baseURL: 'https://api.example.com/v1',
      models: ['gpt-test'],
    });

    const bridge = bridgeApiProviderToAiSdk(provider, {
      async loadProvider(packageName, options) {
        packageSeen = packageName;
        optionsSeen = options;
        return loadedProvider({ languageModel: (modelId) => model(modelId, 'ok') });
      },
    });

    // When
    await bridge?.ensureAvailable?.();

    // Then
    expect(packageSeen).toBe('@ai-sdk/openai');
    expect(typeof optionsSeen?.fetch).toBe('function');
    const { fetch: _fetch, ...rest } = optionsSeen ?? {};
    expect(rest).toEqual({
      apiKey: 'secret',
      baseURL: 'https://api.example.com/v1',
    });
  });
});
