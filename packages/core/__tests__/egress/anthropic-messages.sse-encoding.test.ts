import { describe, expect, test } from 'bun:test';

import {
  collectSSEFrames,
  partStream,
  runtimePartStream,
  toolParts,
  writeAnthropicMessagesSSE,
} from './anthropic-messages.test-support';

describe('writeAnthropicMessagesSSE', () => {
  test('Given independent streams When encoded Then each uses one unique response-local id and resolved model', async () => {
    const encode = () =>
      collectSSEFrames(
        writeAnthropicMessagesSSE(
          partStream([
            { type: 'text-delta', id: 'text-1', text: 'Hello' },
            { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: {} },
          ]),
          { modelId: 'claude-routed' },
        ),
        false,
      );

    const [first, second] = await Promise.all([encode(), encode()]);
    const firstMessage = (first[0]?.data as { message: { id: string; model: string } } | undefined)?.message;
    const secondMessage = (second[0]?.data as { message: { id: string; model: string } } | undefined)?.message;

    expect(firstMessage?.id).toStartWith('msg_');
    expect(firstMessage?.id).not.toBe(secondMessage?.id);
    expect(firstMessage?.model).toBe('claude-routed');
  });

  test('Given text stream When encoded Then emits Anthropic Messages SSE', async () => {
    const stream = partStream([
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

    const frames = await collectSSEFrames(writeAnthropicMessagesSSE(stream));
    expect(frames.map((frame) => frame.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames[0]?.data).toMatchObject({
      type: 'message_start',
      message: { id: 'msg-test', model: 'test-model', container: null, stop_details: null },
    });
    expect(frames[5]?.data).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { input_tokens: 3, output_tokens: 2 },
    });
  });

  test('Given unknown raw parts When encoded Then skips them without crashing', async () => {
    const stream = runtimePartStream([
      { type: '__future-part', payload: 'ignored' },
      { type: 'text-delta', id: 'text-1', text: 'safe' },
      { type: 'raw', rawValue: { ignored: true } },
      { type: 'error', error: new Error('ignored') },
      {
        type: 'finish',
        finishReason: 'stop',
        totalUsage: {},
      },
    ]);

    const frames = await collectSSEFrames(writeAnthropicMessagesSSE(stream));
    expect(frames.map((frame) => frame.event)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);
    expect(frames[2]?.data).toMatchObject({ delta: { type: 'text_delta', text: 'safe' } });
  });

  test('Given tool input stream When encoded Then emits Anthropic tool_use SSE', async () => {
    const frames = await collectSSEFrames(writeAnthropicMessagesSSE(partStream(toolParts)));
    expect(frames[1]?.data).toMatchObject({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: 'tool-1', name: 'weather', caller: { type: 'direct' } },
    });
    expect(frames[4]?.data).toMatchObject({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use' },
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });
});
