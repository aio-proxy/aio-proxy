import { describe, expect, test } from 'bun:test';

import { collectSSEFrames, partStream, writeAnthropicMessagesSSE } from './anthropic-messages.test-support';

describe('writeAnthropicMessagesSSE', () => {
  test('Given interleaved open blocks When finished Then indices stay associated and all blocks close', async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: 'text-start', id: 'text-1' },
          { type: 'text-delta', id: 'text-1', text: 'before' },
          { type: 'tool-input-start', id: 'tool-1', toolName: 'weather' },
          { type: 'tool-input-start', id: 'tool-2', toolName: 'clock' },
          { type: 'tool-input-delta', id: 'tool-1', delta: '{"city":"Paris"}' },
          { type: 'tool-input-delta', id: 'tool-2', delta: '{"zone":"UTC"}' },
          { type: 'text-start', id: 'text-2' },
          { type: 'text-delta', id: 'text-2', text: 'after' },
          {
            type: 'finish',
            finishReason: 'tool-calls',
            rawFinishReason: 'tool_use',
            totalUsage: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
          },
        ]),
      ),
    );

    expect(frames.filter((frame) => frame.event === 'content_block_start').map((frame) => frame.data)).toEqual([
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: null } },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'tool-1', name: 'weather', input: {}, caller: { type: 'direct' } },
      },
      {
        type: 'content_block_start',
        index: 2,
        content_block: { type: 'tool_use', id: 'tool-2', name: 'clock', input: {}, caller: { type: 'direct' } },
      },
      { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '', citations: null } },
    ]);
    expect(
      frames
        .filter(
          (frame) =>
            frame.event === 'content_block_delta' &&
            typeof frame.data === 'object' &&
            frame.data !== null &&
            'delta' in frame.data &&
            (frame.data.delta as { type?: string }).type === 'input_json_delta',
        )
        .map((frame) => frame.data),
    ).toEqual([
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"city":"Paris"}' },
      },
      {
        type: 'content_block_delta',
        index: 2,
        delta: { type: 'input_json_delta', partial_json: '{"zone":"UTC"}' },
      },
    ]);

    const messageDeltaIndex = frames.findIndex((frame) => frame.event === 'message_delta');
    expect(messageDeltaIndex).toBeGreaterThan(0);
    expect(
      frames
        .slice(0, messageDeltaIndex)
        .filter((frame) => frame.event === 'content_block_stop')
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1, 2, 3]);
    expect(frames.slice(messageDeltaIndex + 1).some((frame) => frame.event === 'content_block_stop')).toBeFalse();
  });
});
