import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkProviderLoadOptions } from '../../index';
import { bridgeApiProviderToAiSdk } from '../../index';
import { loadedProvider, model } from './api-bridge-test-helpers';

declare const process: {
  readonly env: Record<string, string | undefined>;
};

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

describe('bridgeApiProviderToAiSdk', () => {
  test('Given api provider protocols When bridged Then package and options are forwarded', async () => {
    // Given
    const previousKey = process.env.AIO_PROXY_BRIDGE_KEY;
    process.env.AIO_PROXY_BRIDGE_KEY = 'env-bridge-secret';
    const cases = [
      {
        protocol: ProviderProtocol.OpenAICompatible,
        packageName: '@ai-sdk/openai-compatible',
        options: {
          apiKey: 'env-bridge-secret',
          baseURL: 'https://api.example.com/v1',
          name: 'provider-openai-compatible',
        },
      },
      {
        protocol: ProviderProtocol.Anthropic,
        packageName: '@ai-sdk/anthropic',
        options: {
          apiKey: 'env-bridge-secret',
          baseURL: 'https://api.example.com/v1',
        },
      },
      {
        protocol: ProviderProtocol.Gemini,
        packageName: '@ai-sdk/google',
        options: {
          apiKey: 'env-bridge-secret',
          baseURL: 'https://api.example.com/v1',
        },
      },
      {
        protocol: ProviderProtocol.OpenAIResponse,
        packageName: '@ai-sdk/openai',
        options: {
          apiKey: 'env-bridge-secret',
          baseURL: 'https://api.example.com/v1',
        },
      },
    ] as const;

    try {
      for (const expected of cases) {
        let packageSeen: string | undefined;
        let optionsSeen: AiSdkProviderLoadOptions | undefined;
        const bridge = bridgeApiProviderToAiSdk(
          {
            kind: ProviderKind.Api,
            id: `provider-${expected.protocol}`,
            protocol: expected.protocol,
            apiKey: '$AIO_PROXY_BRIDGE_KEY',
            baseURL: 'https://api.example.com/v1',
            models: ['gpt-test'],
          },
          {
            async loadProvider(packageName, options) {
              packageSeen = packageName;
              optionsSeen = options;
              return loadedProvider({
                languageModel: (modelId) => model(modelId, 'ok'),
              });
            },
          },
        );

        // When
        await bridge?.ensureAvailable?.();

        // Then
        expect(bridge?.id).toBe(`provider-${expected.protocol}:bridge`);
        expect(bridge?.kind).toBe(ProviderKind.AiSdk);
        expect(bridge?.models).toEqual(['gpt-test']);
        expect(packageSeen).toBe(expected.packageName);
        const openAI =
          expected.packageName === '@ai-sdk/openai' || expected.packageName === '@ai-sdk/openai-compatible';
        if (openAI) {
          expect(typeof optionsSeen?.fetch).toBe('function');
          const { fetch: _fetch, ...rest } = optionsSeen ?? {};
          expect(rest).toEqual(expected.options);
        } else {
          expect(optionsSeen).toEqual(expected.options);
        }
      }
    } finally {
      if (previousKey === undefined) {
        delete process.env.AIO_PROXY_BRIDGE_KEY;
      } else {
        process.env.AIO_PROXY_BRIDGE_KEY = previousKey;
      }
    }
  });
});
