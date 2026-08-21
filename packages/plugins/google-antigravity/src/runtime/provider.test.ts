import { describe, expect, test } from 'bun:test';

import type { ModelCatalog } from '@aio-proxy/plugin-sdk';

import { bindAntigravityThinking } from '../protocol/thinking';
import { createAntigravityLanguageModel } from './google-model';
import { createAntigravityProviderV4 } from './provider';
import {
  callOptions,
  captureStreamTransport,
  captureTransport,
  collect,
  fixtureRuntime,
  logicalContext,
  textResponse,
} from './provider.test-support';
import type { CcaTransport } from './transport';

describe('Google Antigravity ProviderV4', () => {
  test('exposes literal v4 language models for the routed wire ID', () => {
    const provider = createAntigravityProviderV4(fixtureRuntime(captureTransport({}).transport));

    const model = provider.languageModel('gemini-3-flash-agent');

    expect(provider.specificationVersion).toBe('v4');
    expect(model.specificationVersion).toBe('v4');
    expect(model.modelId).toBe('gemini-3-flash-agent');
    expect(() => provider.embeddingModel('embedding')).toThrow('does not support embedding');
    expect(() => provider.imageModel('image')).toThrow('does not support image generation');
  });

  test('uses the Google codec while stripping private options and preserving images and Google options', async () => {
    const response = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'hello' }, { functionCall: { id: 'call-1', name: 'weather', args: { city: 'Shanghai' } } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
    };
    const captured = captureTransport(response);
    const model = createAntigravityLanguageModel(
      'gemini-3-flash-agent',
      catalogRuntime(captured.transport, reasoningCatalog()),
    );

    const result = await model.doGenerate({
      prompt: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array([1, 2, 3]) } },
          ],
        },
      ],
      providerOptions: {
        google: { responseModalities: ['TEXT'] },
        aioProxy: { logicalRequest: logicalContext(), thinking: { mode: 'adaptive', effort: 'high' } },
      },
    } as never);

    expect(result.content).toContainEqual({ type: 'text', text: 'hello', providerMetadata: undefined });
    expect(result.content).toContainEqual(
      expect.objectContaining({ type: 'tool-call', toolCallId: 'call-1', toolName: 'weather' }),
    );
    expect(result.finishReason).toEqual({ unified: 'tool-calls', raw: 'STOP' });
    expect(result.usage).toMatchObject({ inputTokens: { total: 3 }, outputTokens: { total: 2, text: 2 } });
    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]).toMatchObject({
      context: logicalContext(),
      modelId: 'gemini-3-flash-agent',
      requestType: 'agent',
      stream: false,
      body: {
        generationConfig: {
          responseModalities: ['TEXT'],
          thinkingConfig: { thinkingBudget: 10000, includeThoughts: true },
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: 'what is this?' }, { inlineData: { mimeType: 'image/png', data: 'AQID' } }],
          },
        ],
      },
    });
    expect(JSON.stringify(captured.calls[0]?.body)).not.toContain('aioProxy');
  });

  test('decodes CCA SSE through the Google stream codec', async () => {
    const captured = captureStreamTransport([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'hello' }] } }] },
      {
        candidates: [
          {
            content: { role: 'model', parts: [{ functionCall: { id: 'call-2', name: 'weather', args: {} } }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 3, totalTokenCount: 7 },
      },
    ]);
    const model = createAntigravityLanguageModel('gemini-3-flash-agent', fixtureRuntime(captured.transport));

    const result = await model.doStream(callOptions());
    const parts = await collect(result.stream);

    expect(parts).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'hello' }));
    expect(parts).toContainEqual(
      expect.objectContaining({ type: 'tool-call', toolCallId: 'call-2', toolName: 'weather' }),
    );
    expect(parts).toContainEqual(
      expect.objectContaining({
        type: 'finish',
        finishReason: { unified: 'tool-calls', raw: 'STOP' },
        usage: expect.objectContaining({ inputTokens: expect.objectContaining({ total: 4 }) }),
      }),
    );
    expect(captured.calls[0]).toMatchObject({ modelId: 'gemini-3-flash-agent', stream: true });
  });

  test('captures OpenAI reasoning high as adaptive mapper output before the Google codec', async () => {
    const captured = captureTransport(textResponse('ok'));
    const catalog = reasoningCatalog();
    const model = createAntigravityLanguageModel('gemini-3-flash-agent', catalogRuntime(captured.transport, catalog));

    await model.doGenerate({
      ...callOptions(),
      reasoning: 'high',
    } as never);

    expect(captured.calls[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 10_000, includeThoughts: true } },
    });
    expect(JSON.stringify(captured.calls[0]?.body)).not.toContain('thinkingLevel');
  });

  test('maps OpenAI reasoning none on gemini-3 to budget 0 instead of thinkingLevel minimal', async () => {
    const captured = captureTransport(textResponse('ok'));
    const catalog = reasoningCatalog();
    const model = createAntigravityLanguageModel('gemini-3-flash-agent', catalogRuntime(captured.transport, catalog));

    await model.doGenerate({
      ...callOptions(),
      reasoning: 'none',
    } as never);

    expect(captured.calls[0]?.body).toMatchObject({
      generationConfig: { thinkingConfig: { thinkingBudget: 0, includeThoughts: false } },
    });
    expect(JSON.stringify(captured.calls[0]?.body)).not.toContain('minimal');
    expect(JSON.stringify(captured.calls[0]?.body)).not.toContain('thinkingLevel');
  });

  test.each([
    ['gemini-pro-agent', { thinkingLevel: 'high' }],
    ['claude-sonnet-4-6', { thinkingBudget: 16_384, includeThoughts: true }],
  ] as const)(
    'does not keep codec numeric budgets for OpenAI reasoning high on %s',
    async (modelId, thinkingConfig) => {
      const captured = captureTransport(textResponse('ok'));
      const catalog = reasoningCatalog();
      const model = createAntigravityLanguageModel(modelId, catalogRuntime(captured.transport, catalog));

      await model.doGenerate({
        ...callOptions(),
        reasoning: 'high',
      } as never);

      expect(captured.calls[0]?.body).toMatchObject({ generationConfig: { thinkingConfig } });
      if ('thinkingLevel' in thinkingConfig) {
        expect(captured.calls[0]?.body).not.toMatchObject({
          generationConfig: { thinkingConfig: { thinkingBudget: expect.any(Number) } },
        });
      }
    },
  );
});

function catalogRuntime(transport: CcaTransport, catalog: ModelCatalog) {
  return {
    call: (context: ReturnType<typeof logicalContext>) => ({
      catalog,
      context,
      thinkingBinder: bindAntigravityThinking(catalog),
      transport,
    }),
  };
}

function reasoningCatalog(): ModelCatalog {
  return {
    language: [
      {
        id: 'gemini-3-flash-agent',
        metadata: { antigravity: { apiProvider: 'gemini', thinkingBudget: 10_000 } },
      },
      {
        id: 'gemini-pro-agent',
        metadata: { antigravity: { apiProvider: 'gemini', thinkingBudget: -1 } },
      },
      {
        id: 'claude-sonnet-4-6',
        metadata: { antigravity: { apiProvider: 'anthropic' } },
      },
    ],
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
    metadata: {
      antigravityFamilies: [
        {
          logicalId: 'gemini-3.5-flash',
          kind: 'split',
          thinking: { mode: 'gemini' },
          base: 'gemini-3-flash-agent',
          variants: [{ effort: 'high', model: 'gemini-3-flash-agent' }],
        },
        {
          logicalId: 'gemini-3.1-pro',
          kind: 'same-wire',
          thinking: { mode: 'gemini' },
          base: 'gemini-pro-agent',
          variants: [{ effort: 'high', model: 'gemini-pro-agent' }],
        },
        {
          logicalId: 'claude-sonnet-4-6',
          kind: 'same-wire',
          thinking: { mode: 'claude' },
          base: 'claude-sonnet-4-6',
          variants: [{ effort: 'high', model: 'claude-sonnet-4-6' }],
        },
      ],
    },
  };
}
