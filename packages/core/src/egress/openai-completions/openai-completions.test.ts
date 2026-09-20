import { describe, expect, test } from 'bun:test';

import {
  aiSdkPartStream,
  partStream,
  runtimePartStream,
  writeOpenAICompletionsResponse,
} from './openai-completions.test-support';

describe('writeOpenAICompletionsSSE', () => {
  test('Given finish-step metadata When encoded as response Then upstream metadata is reused', async () => {
    const response = await writeOpenAICompletionsResponse(
      runtimePartStream([
        { type: 'text-delta', id: 'text-1', text: 'pong' },
        {
          type: 'finish-step',
          response: {
            id: 'chatcmpl-upstream',
            modelId: 'gpt-upstream',
            timestamp: new Date('2026-07-12T00:00:05.000Z'),
          },
        },
        { type: 'finish', finishReason: 'stop', totalUsage: {} },
      ]) as never,
      { modelId: 'gpt-fallback' },
    );

    expect(response).toMatchObject({ id: 'chatcmpl-upstream', model: 'gpt-upstream', created: 1_783_814_405 });
  });

  test('Given tool-call stream When encoded as response Then assistant tool calls are preserved', async () => {
    const response = await writeOpenAICompletionsResponse(
      partStream([
        { type: 'tool-input-start', id: 'call_1', toolName: 'lookup' },
        { type: 'tool-input-delta', id: 'call_1', delta: '{"q":"pizza"}' },
        { type: 'tool-input-end', id: 'call_1' },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
        },
      ]),
    );

    expect(response.choices[0]).toMatchObject({
      finish_reason: 'tool_calls',
      message: {
        content: null,
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"q":"pizza"}' },
          },
        ],
      },
    });
  });

  test('Given text stream When encoded as response Then id does not expose aio-proxy', async () => {
    const response = await writeOpenAICompletionsResponse(
      aiSdkPartStream([
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', text: 'pong' },
        { type: 'text-end', id: 'text-1' },
      ]),
    );

    expect(response.id).toStartWith('chatcmpl-');
    expect(response.id).not.toContain('aio-proxy');
  });
});
