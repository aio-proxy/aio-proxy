import { describe, expect, test } from 'bun:test';

import type { CallSettings, ModelMessage, ToolSet } from 'ai';

import { createServer } from '#server-test-lifecycle';

import { aiSdkProvider, responsesRequest, textStream } from './openai-responses.test-support';

describe('OpenAI Responses routes', () => {
  test('Given ai-sdk provider When POST streams text Then Responses SSE events are returned', async () => {
    // Given
    let messagesSeen: readonly ModelMessage[] | undefined;
    let modelSeen: string | undefined;
    let settingsSeen: CallSettings | undefined;
    let toolsSeen: ToolSet | undefined;
    const provider = aiSdkProvider((request) => {
      messagesSeen = request.messages;
      modelSeen = request.modelId;
      settingsSeen = request.settings;
      toolsSeen = request.tools;
      return textStream([
        { type: 'text-delta', id: 'text-1', text: 'pong' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'stop',
          totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]);
    });
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/responses', {
      body: JSON.stringify({
        ...responsesRequest,
        tools: [{ type: 'function', name: 'lookup' }],
      }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const text = await response.text();

    // Then
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(messagesSeen).toEqual([{ role: 'user', content: 'Say pong.' }]);
    expect(modelSeen).toBe('gpt-4.1-mini');
    expect(settingsSeen).toEqual({
      providerOptions: { openai: { store: false } },
      stream: true,
    });
    expect(Object.keys(toolsSeen ?? {})).toEqual(['lookup']);
    expect(text).toContain('event: response.created');
    expect(text).toContain('event: response.output_item.added');
    expect(text).toContain('event: response.output_text.delta');
    expect(text).toContain('"delta":"pong"');
    expect(text).toContain('event: response.completed');
  });

  test('Given ai-sdk provider When POST is non-stream Then Responses JSON is returned', async () => {
    // Given
    const provider = aiSdkProvider(() =>
      textStream([
        { type: 'text-delta', id: 'text-1', text: 'Pong' },
        {
          type: 'finish',
          finishReason: 'stop',
          rawFinishReason: 'stop',
          totalUsage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        },
      ]),
    );
    const app = await createServer({
      config: { providers: {} },
      providerInstances: [provider],
    });

    // When
    const response = await app.request('/v1/responses', {
      body: JSON.stringify({ ...responsesRequest, stream: false }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body.id).toStartWith('resp_');
    expect(body).toMatchObject({
      object: 'response',
      model: 'gpt-4.1-mini',
      output_text: 'Pong',
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Pong', annotations: [] }],
        },
      ],
      status: 'completed',
      usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
    });
  });
});
