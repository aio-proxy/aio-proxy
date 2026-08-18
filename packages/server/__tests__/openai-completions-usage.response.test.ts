import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import type { AiSdkProviderInstance } from '@aio-proxy/core';

import { createServer } from '#server-test-lifecycle';

import { chatRequest, mockModelsDevCatalog, restoreFetch, textStream } from './openai-completions.test-support';

beforeEach(mockModelsDevCatalog);
afterEach(restoreFetch);

describe('POST /v1/chat/completions', () => {
  test('Given ai-sdk provider When non-stream completion is posted Then OpenAI JSON is returned', async () => {
    // Given
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      invoke() {
        return textStream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', text: 'Hel' },
          { type: 'text-delta', id: 'text-1', text: 'lo' },
          { type: 'text-end', id: 'text-1' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
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
      body: JSON.stringify({ ...chatRequest, stream: false }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body.id).toStartWith('chatcmpl-');
    expect(body.id).not.toContain('aio-proxy');
    expect(body).toMatchObject({
      object: 'chat.completion',
      choices: [
        {
          finish_reason: 'stop',
          index: 0,
          logprobs: null,
          message: { role: 'assistant', content: 'Hello', refusal: null },
        },
      ],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
      },
    });
  });

  test('Given ai-sdk provider When stream is omitted Then OpenAI JSON is returned', async () => {
    // Given
    const provider = {
      id: 'mock-ai',
      kind: 'ai-sdk',
      models: ['gpt-4o-mini'],
      alias: { 'gpt-4o-mini': { model: 'gpt-4o-mini', preserve: false } },
      invoke() {
        return textStream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', text: 'Hello' },
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
      body: JSON.stringify({ model: chatRequest.model, messages: chatRequest.messages }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.content).toBe('Hello');
  });
});
