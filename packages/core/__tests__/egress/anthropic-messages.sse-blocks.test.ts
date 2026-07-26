import { describe, expect, test } from 'bun:test';

import { collectSSEFrames, partStream, writeAnthropicMessagesSSE } from './anthropic-messages.test-support';

describe('writeAnthropicMessagesSSE', () => {
  test('Given an empty text block When encoded Then start and stop are preserved', async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: 'text-start', id: 'text-empty' },
          { type: 'text-end', id: 'text-empty' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          },
        ]),
      ),
    );

    expect(frames.filter((frame) => frame.event.startsWith('content_block_'))).toEqual([
      {
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        },
      },
      { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    ]);
  });

  test('Given empty text and tool blocks When encoded Then first-appearance order determines indices', async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: 'text-start', id: 'text-empty' },
          { type: 'tool-input-start', id: 'tool-1', toolName: 'weather' },
          { type: 'text-end', id: 'text-empty' },
          { type: 'tool-input-end', id: 'tool-1' },
          { type: 'text-start', id: 'text-after' },
          { type: 'text-delta', id: 'text-after', text: 'done' },
          { type: 'text-end', id: 'text-after' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ]),
      ),
    );

    expect(
      frames
        .filter((frame) => frame.event === 'content_block_start')
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1, 2]);
    expect(
      frames
        .filter((frame) => frame.event === 'content_block_stop')
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1, 2]);
  });
});
