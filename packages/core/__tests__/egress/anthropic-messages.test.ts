import { describe, expect, test } from 'bun:test';

import {
  partStream,
  runtimePartStream,
  toolParts,
  writeAnthropicMessagesResponse,
} from './anthropic-messages.test-support';

describe('writeAnthropicMessagesResponse', () => {
  test('Given finish-step metadata When encoded Then upstream id and model are reused', async () => {
    const response = await writeAnthropicMessagesResponse(
      runtimePartStream([
        { type: 'text-delta', id: 'text-1', text: 'Hello' },
        {
          type: 'finish-step',
          response: {
            id: 'msg_upstream',
            modelId: 'claude-upstream',
            timestamp: new Date('2026-07-12T00:00:00.000Z'),
          },
        },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 1, outputTokens: 1 } },
      ]) as never,
      { modelId: 'claude-fallback' },
    );

    expect(response.id).toBe('msg_upstream');
    expect(response.model).toBe('claude-upstream');
  });

  test('Given tool input stream When encoded Then emits Anthropic tool_use content', async () => {
    await expect(writeAnthropicMessagesResponse(partStream(toolParts))).resolves.toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'weather',
          input: { city: 'Paris' },
        },
      ],
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 4 },
    });
  });

  test('Given interleaved text and tools When encoded Then preserves content-block order', async () => {
    const stream = partStream([
      { type: 'tool-input-start', id: 'tool-1', toolName: 'weather' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '{"city":' },
      { type: 'tool-input-delta', id: 'tool-1', delta: '"Paris"' },
      { type: 'tool-input-end', id: 'tool-1' },
      { type: 'text-start', id: 'text-1' },
      { type: 'text-delta', id: 'text-1', text: 'After ' },
      { type: 'text-delta', id: 'text-1', text: 'weather.' },
      { type: 'text-end', id: 'text-1' },
      { type: 'tool-input-start', id: 'tool-2', toolName: 'clock' },
      { type: 'tool-input-delta', id: 'tool-2', delta: '{"zone":' },
      { type: 'tool-input-delta', id: 'tool-2', delta: '"UTC"}' },
      { type: 'tool-input-end', id: 'tool-2' },
      { type: 'text-start', id: 'text-2' },
      { type: 'text-delta', id: 'text-2', text: ' Done.' },
      { type: 'text-end', id: 'text-2' },
      {
        type: 'finish',
        finishReason: 'tool-calls',
        rawFinishReason: 'tool_use',
        totalUsage: { inputTokens: 5, outputTokens: 8, totalTokens: 13 },
      },
    ]);

    await expect(writeAnthropicMessagesResponse(stream)).resolves.toMatchObject({
      type: 'message',
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'weather',
          input: '{"city":"Paris"',
        },
        { type: 'text', text: 'After weather.' },
        {
          type: 'tool_use',
          id: 'tool-2',
          name: 'clock',
          input: { zone: 'UTC' },
        },
        { type: 'text', text: ' Done.' },
      ],
      model: 'test-model',
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 8 },
    });
  });
});
