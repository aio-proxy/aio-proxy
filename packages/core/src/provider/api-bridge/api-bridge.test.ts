import { describe, expect, test } from 'bun:test';

import { ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import type { AiSdkProviderLoadOptions, ProviderFetch } from '../../index';
import { bridgeApiProviderToAiSdk } from '../../index';
import { collect, loadedProvider, messages, model } from './api-bridge-test-helpers';

declare const process: {
  readonly env: Record<string, string | undefined>;
};

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const ANTHROPIC_TERMINAL =
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg","type":"message","role":"assistant","model":"glm-4.7","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n' +
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
  'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function capturedUpstreamRequest(
  provider: Parameters<typeof bridgeApiProviderToAiSdk>[0],
  modelId: string,
  sse = '',
): Promise<Request> {
  let upstream: Request | undefined;
  const bridge = bridgeApiProviderToAiSdk(provider, {
    fetch: (async (input, init) => {
      upstream = new Request(input, init);
      return new Response(sse, { headers: { 'content-type': 'text/event-stream' }, status: 200 });
    }) as ProviderFetch,
  });

  await collect(bridge.invoke({ messages, modelId })).catch(() => []);
  if (upstream === undefined) throw new Error('bridge issued no upstream request');
  return upstream;
}

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

  test('Given an endpoints-only anthropic bearer endpoint When invoked Then the key is sent as a bearer token', async () => {
    const upstream = await capturedUpstreamRequest(
      {
        kind: ProviderKind.Api,
        id: 'zai',
        enabled: true,
        apiKey: 'k',
        models: ['glm-4.7'],
        endpoints: [
          { protocol: ProviderProtocol.Anthropic, baseURL: 'https://api.z.ai/api/anthropic/v1', auth: 'bearer' },
        ],
      },
      'glm-4.7',
      ANTHROPIC_TERMINAL,
    );

    expect(upstream.url.startsWith('https://api.z.ai/api/anthropic/v1/messages')).toBeTrue();
    expect(upstream.headers.get('authorization')).toBe('Bearer k');
    expect(upstream.headers.get('x-api-key')).toBeNull();
  });

  test('Given an endpoints-only openai-compatible endpoint When invoked Then the endpoint base URL is used', async () => {
    const upstream = await capturedUpstreamRequest(
      {
        kind: ProviderKind.Api,
        id: 'gateway',
        enabled: true,
        apiKey: 'k',
        models: ['gpt-test'],
        endpoints: [{ protocol: ProviderProtocol.OpenAICompatible, baseURL: 'https://gw.example.com/v1' }],
      },
      'gpt-test',
    );

    expect(upstream.url.startsWith('https://gw.example.com/v1/chat/completions')).toBeTrue();
  });
});
