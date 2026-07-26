import { describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import type { CallSettings } from 'ai';

import { aiSdkProvider, responsesRequest, textStream } from './openai-responses.test-support';

describe('OpenAI Responses routes', () => {
  test('Given an alias variant and ai-sdk provider When POST is valid Then reasoning selects and configures it', async () => {
    // Given
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gpt-default', 'gpt-high'],
      alias: {
        mini: {
          model: 'gpt-default',
          preserve: false,
          variants: { high: { model: 'gpt-high', preserve: false } },
        },
      },
      invoke(request) {
        modelSeen = request.modelId;
        settingsSeen = request.settings;
        return textStream([
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({ config: { providers: {} }, providerInstances: [provider] });

    // When
    const response = await app.request('/v1/responses', {
      body: JSON.stringify({ ...responsesRequest, model: 'mini', reasoning: { effort: 'high' } }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(modelSeen).toBe('gpt-high');
    expect(settingsSeen).toEqual({
      providerOptions: { openai: { store: false } },
      reasoning: 'high',
      stream: true,
    });
  });

  test('Given ai-sdk provider When POST streams reasoning Then reasoning summary deltas are returned', async () => {
    // Given
    const provider = aiSdkProvider(() =>
      textStream([
        { type: 'reasoning-delta', id: 'reason-1', text: 'Thinking' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'stop',
          totalUsage: {},
        },
      ]),
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/responses', {
      body: JSON.stringify(responsesRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(text).toContain('event: response.reasoning_summary_text.delta');
    expect(text).toContain('"delta":"Thinking"');
  });
});
