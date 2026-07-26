import { describe, expect, test } from 'bun:test';

import { collectSSEFrames, partStream, writeAnthropicMessagesSSE } from './anthropic-messages.test-support';

describe('writeAnthropicMessagesSSE', () => {
  test('Given a stale text-end id When encoded Then it does not close the active text block', async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: 'text-start', id: 'text-old' },
          { type: 'text-delta', id: 'text-old', text: 'old' },
          { type: 'text-end', id: 'text-old' },
          { type: 'text-start', id: 'text-current' },
          { type: 'text-delta', id: 'text-current', text: 'current' },
          { type: 'text-end', id: 'text-old' },
          { type: 'text-delta', id: 'text-current', text: '!' },
          { type: 'text-end', id: 'text-current' },
          {
            type: 'finish',
            finishReason: 'stop',
            rawFinishReason: 'stop',
            totalUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          },
        ]),
      ),
    );

    expect(
      frames
        .filter(
          (frame) =>
            frame.event === 'content_block_delta' &&
            typeof frame.data === 'object' &&
            frame.data !== null &&
            'delta' in frame.data &&
            (frame.data.delta as { type?: string }).type === 'text_delta',
        )
        .map((frame) => frame.data),
    ).toEqual([
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'old' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'current' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '!' } },
    ]);
  });

  test('Given duplicate and stale text lifecycle events When encoded Then blocks start and stop once', async () => {
    const frames = await collectSSEFrames(
      writeAnthropicMessagesSSE(
        partStream([
          { type: 'text-start', id: 'text-old' },
          { type: 'text-start', id: 'text-old' },
          { type: 'text-end', id: 'text-old' },
          { type: 'text-start', id: 'text-current' },
          { type: 'text-start', id: 'text-old' },
          { type: 'text-end', id: 'text-old' },
          { type: 'text-delta', id: 'text-current', text: 'current' },
          { type: 'text-end', id: 'text-current' },
          { type: 'text-end', id: 'text-current' },
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
    ).toEqual([0, 1]);
    expect(
      frames
        .filter((frame) => frame.event === 'content_block_stop')
        .map((frame) => (frame.data as { index: number }).index),
    ).toEqual([0, 1]);
    expect(frames.find((frame) => frame.event === 'content_block_delta')?.data).toEqual({
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: 'current' },
    });
  });
});
