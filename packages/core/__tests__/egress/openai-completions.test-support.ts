import type { LanguageModelV2StreamPart } from '@ai-sdk/provider';
import type { TextStreamPart, ToolSet } from 'ai';

import {
  writeOpenAICompletionsResponse as writeOpenAICompletionsResponseRaw,
  writeOpenAICompletionsSSE as writeOpenAICompletionsSSERaw,
} from '../../src/index';

const defaultEgress = { modelId: 'test-model' };
export const writeOpenAICompletionsResponse = (
  stream: Parameters<typeof writeOpenAICompletionsResponseRaw>[0],
  context = defaultEgress,
) => writeOpenAICompletionsResponseRaw(stream, context);
export const writeOpenAICompletionsSSE = (
  stream: Parameters<typeof writeOpenAICompletionsSSERaw>[0],
  context = defaultEgress,
) => writeOpenAICompletionsSSERaw(stream, context);

export const doneFrame = 'data: [DONE]\n\n';

export async function collectSSE(stream: ReadableStream<Uint8Array>, compactOfficialFields = true): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  const value = chunks.join('').replaceAll(/chatcmpl-[^"]+/g, 'chatcmpl-test');
  return compactOfficialFields
    ? value
        .replaceAll(/,"created":\d+,"model":"test-model"/g, '')
        .replaceAll(',"finish_reason":null', '')
        .replaceAll('{"prompt_tokens":0,"completion_tokens":0,"total_tokens":9}', '{"total_tokens":9}')
    : value;
}

export function partStream(parts: readonly LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

export function aiSdkPartStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
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
