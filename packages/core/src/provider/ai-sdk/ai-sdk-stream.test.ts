import { describe, expect, test } from 'bun:test';

import type { LanguageModelV2, LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { LogicalRequestContext } from '@aio-proxy/plugin-sdk';

import { createAiSdkProvider } from '../../index';
import { collect, messages, textPartStream } from './ai-sdk-test-helpers';

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const stableContext = {
  requestId: 'request-1',
  session: { key: `sha256:${'a'.repeat(64)}`, source: 'body-session' },
} satisfies LogicalRequestContext;

type SessionProjectionCase = readonly [
  packageName: string,
  options: Readonly<Record<string, unknown>>,
  expectedProviderOptions: Readonly<Record<string, unknown>>,
];

const sessionProjectionCases: readonly SessionProjectionCase[] = [
  ['@ai-sdk/anthropic', {}, { anthropic: { metadata: { userId: `sha256:${'a'.repeat(64)}` } } }],
  ['@ai-sdk/openai', {}, { openai: { promptCacheKey: 'a'.repeat(64) } }],
  [
    '@ai-sdk/openai-compatible',
    { baseURL: 'https://example.test/v1', name: 'custom-compatible' },
    { 'custom-compatible': { user: `sha256:${'a'.repeat(64)}` } },
  ],
  ['@ai-sdk/openai-compatible', {}, { 'fallback-name': { user: `sha256:${'a'.repeat(64)}` } }],
];

const noProjectionCases: readonly (readonly [string, LogicalRequestContext])[] = [
  ['@ai-sdk/openai', { requestId: 'request-generated', session: { key: 'sha256:random', source: 'generated' } }],
  ['@ai-sdk/google', stableContext],
];

describe('createAiSdkProvider stream', () => {
  test.each(sessionProjectionCases)(
    'projects a stable session for %s',
    async (packageName, options, expectedProviderOptions) => {
      let call: { readonly providerOptions?: unknown } | undefined;
      const model = {
        specificationVersion: 'v2',
        provider: 'mock',
        modelId: 'mock-model',
        supportedUrls: {},
        async doGenerate() {
          throw new Error('doGenerate should not be called');
        },
        async doStream(input: { readonly providerOptions?: unknown }) {
          call = input;
          return {
            stream: textPartStream([
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
              },
            ]),
          };
        },
      } satisfies LanguageModelV2;
      const provider = createAiSdkProvider(
        { kind: 'ai-sdk', id: 'fallback-name', packageName, models: ['mock-model'], options },
        { resolveModel: () => model },
      );

      await collect(
        provider.invoke({
          context: stableContext,
          messages,
          modelId: 'mock-model',
          settings: { providerOptions: { aioProxy: { retain: true } } },
        }),
      );

      expect(call?.providerOptions).toEqual({ aioProxy: { retain: true }, ...expectedProviderOptions });
    },
  );

  test.each(noProjectionCases)(
    'does not project a session for %s when the target cannot use it',
    async (packageName, context) => {
      let call: { readonly providerOptions?: unknown } | undefined;
      const model = {
        specificationVersion: 'v2',
        provider: 'mock',
        modelId: 'mock-model',
        supportedUrls: {},
        async doGenerate() {
          throw new Error('doGenerate should not be called');
        },
        async doStream(input: { readonly providerOptions?: unknown }) {
          call = input;
          return {
            stream: textPartStream([
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
              },
            ]),
          };
        },
      } satisfies LanguageModelV2;
      const provider = createAiSdkProvider(
        { kind: 'ai-sdk', id: 'provider', packageName, models: ['mock-model'] },
        { resolveModel: () => model },
      );

      await collect(
        provider.invoke({
          context,
          messages,
          modelId: 'mock-model',
          settings: { providerOptions: { aioProxy: { retain: true } } },
        }),
      );

      expect(call?.providerOptions).toEqual({ aioProxy: { retain: true } });
    },
  );

  test('does not overwrite an authored Anthropic metadata user ID', async () => {
    let call: { readonly providerOptions?: unknown } | undefined;
    const model = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('doGenerate should not be called');
      },
      async doStream(input: { readonly providerOptions?: unknown }) {
        call = input;
        return {
          stream: textPartStream([
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
            },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      { kind: 'ai-sdk', id: 'anthropic', packageName: '@ai-sdk/anthropic', models: ['mock-model'] },
      { resolveModel: () => model },
    );

    await collect(
      provider.invoke({
        context: stableContext,
        messages,
        modelId: 'mock-model',
        settings: { providerOptions: { anthropic: { metadata: { userId: 'caller-value' } } } },
      }),
    );

    expect(call?.providerOptions).toEqual({ anthropic: { metadata: { userId: 'caller-value' } } });
  });

  test('yields the exact model-origin stream parts in order', async () => {
    const modelParts: readonly LanguageModelV2StreamPart[] = [
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', delta: 'hi' },
      { type: 'text-end', id: 'text-1' },
    ];
    const model = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('doGenerate should not be called');
      },
      async doStream() {
        return { stream: textPartStream(modelParts) };
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

    const parts = await collect(provider.invoke({ messages, modelId: 'mock-model' }));

    expect(parts.filter((part) => part.type.startsWith('text'))).toEqual([
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', text: 'hi' },
      { type: 'text-end', id: 'text-1' },
    ]);
  });

  test('moves system messages into AI SDK instructions', async () => {
    let promptSeen: unknown;
    const model = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-model',
      supportedUrls: {},
      async doGenerate() {
        throw new Error('doGenerate should not be called');
      },
      async doStream(options) {
        promptSeen = options.prompt;
        return {
          stream: textPartStream([
            { type: 'text-start', id: 'text-1' },
            { type: 'text-delta', id: 'text-1', delta: 'ok' },
            { type: 'text-end', id: 'text-1' },
          ]),
        };
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

    await collect(
      provider.invoke({
        messages: [
          { role: 'system', content: 'Be brief.' },
          { role: 'user', content: 'hello' },
        ],
        modelId: 'mock-model',
      }),
    );

    expect(promptSeen).toEqual([
      { role: 'system', content: 'Be brief.', providerOptions: undefined },
      { role: 'user', content: [{ type: 'text', text: 'hello' }], providerOptions: undefined },
    ]);
  });
});
