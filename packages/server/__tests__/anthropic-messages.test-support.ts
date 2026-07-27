import type { TextStreamPart, ToolSet } from 'ai';

export { createTempHomes } from './temporary-homes.test-support';

export const messagesRequest = {
  model: 'claude-sonnet-4-5',
  max_tokens: 32,
  messages: [{ role: 'user', content: 'Hello proxy' }],
  stream: true,
};
export { recorded } from './trace-recording.test-support';

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export class AbortStreamError extends Error {
  override readonly name = 'AbortError';
}
