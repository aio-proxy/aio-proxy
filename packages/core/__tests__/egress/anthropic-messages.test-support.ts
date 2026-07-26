import type { TextStreamPart, ToolSet } from 'ai';

import {
  writeAnthropicMessagesResponse as writeAnthropicMessagesResponseRaw,
  writeAnthropicMessagesSSE as writeAnthropicMessagesSSERaw,
} from '../../src/index';

const defaultEgress = { modelId: 'test-model' };
export const writeAnthropicMessagesResponse = (
  stream: Parameters<typeof writeAnthropicMessagesResponseRaw>[0],
  context = defaultEgress,
) => writeAnthropicMessagesResponseRaw(stream, context);
export const writeAnthropicMessagesSSE = (
  stream: Parameters<typeof writeAnthropicMessagesSSERaw>[0],
  context = defaultEgress,
) => writeAnthropicMessagesSSERaw(stream, context);

export const toolParts = [
  { type: 'tool-input-start', id: 'tool-1', toolName: 'weather' },
  { type: 'tool-input-delta', id: 'tool-1', delta: '{"city":"Paris"}' },
  { type: 'tool-input-end', id: 'tool-1' },
  {
    type: 'finish',
    finishReason: 'tool-calls',
    rawFinishReason: 'tool_use',
    totalUsage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
  },
] satisfies readonly TextStreamPart<ToolSet>[];

async function collectSSE(stream: ReadableStream<Uint8Array>, normalizeId = true): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  const value = chunks.join('');
  return normalizeId ? value.replaceAll(/msg_[0-9a-f-]{36}/g, 'msg-test') : value;
}

export async function collectSSEFrames(stream: ReadableStream<Uint8Array>, normalizeId = true) {
  return (await collectSSE(stream, normalizeId))
    .trim()
    .split('\n\n')
    .map((frame) => {
      const [eventLine, dataLine] = frame.split('\n');
      return {
        event: eventLine?.slice('event: '.length),
        data: JSON.parse(dataLine?.slice('data: '.length) ?? 'null') as unknown,
      };
    });
}

export function partStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export function runtimePartStream(parts: readonly object[]) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}
