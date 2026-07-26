import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkProviderLoadOptions, ProviderFetch } from '../../index';
import { bridgeApiProviderToAiSdk } from '../../index';
import { collect, loadedProvider, messages, model } from './api-bridge-test-helpers';

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

describe('bridgeApiProviderToAiSdk', () => {
  test('forwards configured headers and injected fetch for every protocol', async () => {
    const providerFetch = (async () => new Response('ok')) as ProviderFetch;
    const headers = { Authorization: 'Bearer configured', 'X-Tenant': 'team-a' };
    const protocols = [
      ProviderProtocol.OpenAICompatible,
      ProviderProtocol.Anthropic,
      ProviderProtocol.Gemini,
      ProviderProtocol.OpenAIResponse,
    ] as const;

    for (const protocol of protocols) {
      let optionsSeen: AiSdkProviderLoadOptions | undefined;
      const bridge = bridgeApiProviderToAiSdk(
        {
          kind: ProviderKind.Api,
          id: `provider-${protocol}`,
          protocol,
          apiKey: 'secret',
          baseURL: 'https://api.example.com/v1',
          headers,
          models: ['gpt-test'],
        },
        {
          fetch: providerFetch,
          async loadProvider(_packageName, options) {
            optionsSeen = options;
            return loadedProvider({
              languageModel: (modelId) => model(modelId, 'ok'),
            });
          },
        },
      );

      await bridge?.ensureAvailable?.();

      const openAI = protocol === ProviderProtocol.OpenAICompatible || protocol === ProviderProtocol.OpenAIResponse;
      if (openAI) {
        expect(optionsSeen?.fetch).not.toBe(providerFetch);
        expect(typeof optionsSeen?.fetch).toBe('function');
      } else {
        expect(optionsSeen?.fetch).toBe(providerFetch);
      }
      expect(optionsSeen?.headers).toEqual({
        Authorization: 'Bearer configured',
        'X-Tenant': 'team-a',
      });
      expect(optionsSeen?.apiKey).toBe('secret');
      expect(optionsSeen?.baseURL).toBe('https://api.example.com/v1');
    }
  });

  test('Given OpenAI Responses bridge When provider exposes responses Then responses model is preferred', async () => {
    // Given
    let responsesSeen: string | undefined;
    let languageSeen: string | undefined;
    const bridge = bridgeApiProviderToAiSdk(
      {
        kind: ProviderKind.Api,
        id: 'responses',
        protocol: ProviderProtocol.OpenAIResponse,
        baseURL: 'https://api.example.com/v1',
        models: ['gpt-test'],
      },
      {
        async loadProvider() {
          return loadedProvider({
            languageModel(modelId) {
              languageSeen = modelId;
              return model(modelId, 'language');
            },
            responses(modelId) {
              responsesSeen = modelId;
              return model(modelId, 'responses');
            },
          });
        },
      },
    );

    // When
    const parts = bridge === undefined ? [] : await collect(bridge.invoke({ messages, modelId: 'gpt-test' }));

    // Then
    expect(responsesSeen).toBe('gpt-test');
    expect(languageSeen).toBeUndefined();
    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'text-1', text: 'responses' },
    ]);
  });

  test('Given OpenAI Responses bridge without responses resolver When invoked Then languageModel is used', async () => {
    // Given
    let languageSeen: string | undefined;
    const bridge = bridgeApiProviderToAiSdk(
      {
        kind: ProviderKind.Api,
        id: 'responses',
        protocol: ProviderProtocol.OpenAIResponse,
        baseURL: 'https://api.example.com/v1',
        models: ['gpt-test'],
      },
      {
        async loadProvider() {
          return loadedProvider({
            languageModel(modelId) {
              languageSeen = modelId;
              return model(modelId, 'language');
            },
          });
        },
      },
    );

    // When
    const parts = bridge === undefined ? [] : await collect(bridge.invoke({ messages, modelId: 'gpt-test' }));

    // Then
    expect(languageSeen).toBe('gpt-test');
    expect(parts.filter((part) => part.type === 'text-delta')).toEqual([
      { type: 'text-delta', id: 'text-1', text: 'language' },
    ]);
  });
});
