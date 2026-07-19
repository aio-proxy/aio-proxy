import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { TextStreamPart, ToolSet } from "ai";

import {
  writeOpenAIResponsesResponse as writeOpenAIResponsesResponseRaw,
  writeOpenAIResponsesSSE as writeOpenAIResponsesSSERaw,
} from "../index";

const defaultEgress = { modelId: "test-model" };

export const writeOpenAIResponsesResponse = (
  stream: Parameters<typeof writeOpenAIResponsesResponseRaw>[0],
  context = defaultEgress,
) => writeOpenAIResponsesResponseRaw(stream, context);

export const writeOpenAIResponsesSSE = (
  stream: Parameters<typeof writeOpenAIResponsesSSERaw>[0],
  context = defaultEgress,
) => writeOpenAIResponsesSSERaw(stream, context);

export type ResponseEvent = {
  readonly type: string;
  readonly sequence_number: number;
  readonly output_index?: number;
  readonly item_id?: string;
  readonly delta?: string;
  readonly input?: string;
  readonly item?: { readonly id: string; readonly type: string; readonly [key: string]: unknown };
  readonly response?: {
    readonly id: string;
    readonly model: string;
    readonly output: readonly Record<string, unknown>[];
    readonly [key: string]: unknown;
  };
  readonly [key: string]: unknown;
};

export async function frames(stream: ReadableStream<Uint8Array>): Promise<ResponseEvent[]> {
  const decoder = new TextDecoder();
  let body = "";
  for await (const chunk of stream) body += decoder.decode(chunk, { stream: true });
  body += decoder.decode();
  return body
    .trim()
    .split("\n\n")
    .map((frame) => JSON.parse(frame.split("\n")[1]?.slice("data: ".length) ?? "null") as ResponseEvent);
}

export function partStream(parts: readonly unknown[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as LanguageModelV2StreamPart);
      controller.close();
    },
  });
}

export function aiSdkPartStream(parts: readonly unknown[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part as TextStreamPart<ToolSet>);
      controller.close();
    },
  });
}
