import { describe, expect, test } from 'bun:test';

import { createAntigravityLanguageModel } from './google-model';
import { createAntigravityProviderV4 } from './provider';
import {
  callOptions,
  captureStreamTransport,
  captureTransport,
  collect,
  fixtureRuntime,
  logicalContext,
} from './provider.test-support';

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
    const model = createAntigravityLanguageModel('gemini-3-flash-agent', fixtureRuntime(captured.transport));

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
});
