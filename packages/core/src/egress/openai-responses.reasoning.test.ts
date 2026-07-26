import { describe, expect, test } from 'bun:test';

import {
  aiSdkPartStream,
  frames,
  partStream,
  writeOpenAIResponsesResponse,
  writeOpenAIResponsesSSE,
} from './openai-responses-test-support';

describe('OpenAI Responses egress', () => {
  test('Given reasoning stream parts When encoded Then emits exact Responses SSE events', async () => {
    const stream = aiSdkPartStream([
      { type: 'reasoning-start', id: 'reason-1' },
      { type: 'reasoning-delta', id: 'reason-1', text: 'I should answer.' },
      { type: 'reasoning-end', id: 'reason-1' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', text: 'Pong' },
      { type: 'text-end', id: 'text-1' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      },
    ]);

    const events = await frames(writeOpenAIResponsesSSE(stream));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_text.delta',
      'response.output_item.added',
      'response.output_text.delta',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({ delta: 'I should answer.', summary_index: 0 });
    expect(events[4]).toMatchObject({ delta: 'Pong', content_index: 0, logprobs: [] });
    expect(events[5]?.response).toMatchObject({
      status: 'completed',
      output_text: 'Pong',
      usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 },
    });
  });

  test('Given Anthropic-style provider stream When encoded Then reasoning delta maps without metadata', async () => {
    const stream = partStream([
      {
        type: 'reasoning-delta',
        id: 'reason-1',
        delta: 'private summary',
        providerMetadata: {
          anthropic: {
            signature: 'sig',
            encrypted: 'cipher',
          },
        },
      },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: {
          inputTokens: undefined,
          outputTokens: undefined,
          totalTokens: undefined,
        },
      },
    ]);

    const events = await frames(writeOpenAIResponsesSSE(stream));
    expect(events.map((event) => event.type)).toEqual([
      'response.created',
      'response.output_item.added',
      'response.reasoning_summary_text.delta',
      'response.completed',
    ]);
    expect(events[2]).toMatchObject({ delta: 'private summary' });
    expect(events[3]?.response?.output[0]).toMatchObject({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'private summary' }],
    });
  });

  test('Given accumulated text and reasoning When encoded as JSON Then Responses object is returned', async () => {
    const stream = aiSdkPartStream([
      { type: 'reasoning-delta', id: 'reason-1', text: 'summary' },
      { type: 'text-delta', id: 'text-1', text: 'Answer' },
      {
        type: 'finish',
        finishReason: 'stop',
        rawFinishReason: 'stop',
        totalUsage: {
          inputTokens: undefined,
          outputTokens: 2,
          totalTokens: undefined,
        },
      },
    ]);

    await expect(writeOpenAIResponsesResponse(stream)).resolves.toMatchObject({
      object: 'response',
      status: 'completed',
      output: [
        {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'summary' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Answer', annotations: [] }],
        },
      ],
      output_text: 'Answer',
      model: 'test-model',
      usage: { input_tokens: 0, output_tokens: 2, total_tokens: 2 },
    });
  });
});
