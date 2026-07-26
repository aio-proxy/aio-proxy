import { describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance } from '@aio-proxy/core';
import { createServer } from '@aio-proxy/server';
import type { ModelMessage } from 'ai';

import { messagesRequest, textStream } from './anthropic-messages.test-support';

describe('POST /v1/messages', () => {
  test('Given ai-sdk provider When stream message is posted Then provider is invoked and Anthropic SSE is returned', async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['claude-sonnet-4-5'],
      alias: { 'claude-sonnet-4-5': { model: 'claude-sonnet-4-5', preserve: false } },
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
    const response = await app.request('/v1/messages', {
      body: JSON.stringify(messagesRequest),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(messagesSeen).toEqual([{ role: 'user', content: 'Hello proxy' }]);
    expect(modelSeen).toBe('claude-sonnet-4-5');
    expect(text).toContain('event: message_start');
    expect(text).toContain('event: content_block_delta');
    expect(text).toContain('"text":"pong"');
    expect(text).toContain('event: message_stop');
  });
});
