import type { LanguageModelV2StreamPart } from "@ai-sdk/provider";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

export const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

export async function collect(
  stream: ReadableStream<TextStreamPart<ToolSet>>,
): Promise<readonly TextStreamPart<ToolSet>[]> {
  const parts: TextStreamPart<ToolSet>[] = [];
  for await (const part of stream) {
    parts.push(part);
  }

  return parts;
}

export function textPartStream(parts: readonly LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}
