import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance } from '@aio-proxy/core';
import type { ModelMessage } from 'ai';

import { createServer } from '#server-test-lifecycle';

import { chatRequest, mockModelsDevCatalog, restoreFetch, textStream } from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe('POST /v1/chat/completions', () => {
  test('Given ai-sdk provider When stream completion is posted Then provider is invoked and OpenAI SSE is returned', async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      invoke(request) {
        messagesSeen = request.messages;
        modelSeen = request.modelId;
        return textStream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', text: 'pong' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]);
      },
    } satisfies AiSdkProviderInstance;
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/chat/completions', {
      body: JSON.stringify(chatRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(messagesSeen).toEqual([{ role: 'user', content: 'Hello proxy' }]);
    expect(modelSeen).toBe('gpt-4o-mini');
    expect(text).toContain('chat.completion.chunk');
    expect(text).toContain('"content":"pong"');
    expect(text).toContain('data: [DONE]');
  });
});
