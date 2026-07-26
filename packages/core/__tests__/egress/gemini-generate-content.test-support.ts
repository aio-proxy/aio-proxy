import type { TextStreamPart, ToolSet } from 'ai';

import {
  writeGeminiGenerateContentResponse as writeGeminiGenerateContentResponseRaw,
  writeGeminiGenerateContentSSE as writeGeminiGenerateContentSSERaw,
} from '../../src/index';

const defaultEgress = { modelId: 'test-model' };
export const writeGeminiGenerateContentResponse = (
  stream: Parameters<typeof writeGeminiGenerateContentResponseRaw>[0],
  context = defaultEgress,
) => writeGeminiGenerateContentResponseRaw(stream, context);
export const writeGeminiGenerateContentSSE = (
  stream: Parameters<typeof writeGeminiGenerateContentSSERaw>[0],
  context = defaultEgress,
) => writeGeminiGenerateContentSSERaw(stream, context);

export async function collectSSE(stream: ReadableStream<Uint8Array>): Promise<string> {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  for await (const chunk of stream) {
    chunks.push(decoder.decode(chunk, { stream: true }));
  }

  chunks.push(decoder.decode());
  return chunks.join('');
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
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

export type GeminiFrame = {
  readonly candidates: readonly {
    readonly content: { readonly parts: readonly unknown[] };
    readonly finishReason?: string;
  }[];
  readonly modelVersion: string;
  readonly responseId: string;
  readonly usageMetadata?: Record<string, number>;
};
