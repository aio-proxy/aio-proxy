import type { TextStreamPart, ToolSet } from "@aio-proxy/core";

export function textStream(parts: readonly TextStreamPart<ToolSet>[]): ReadableStream<TextStreamPart<ToolSet>> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

export function finishPart(): TextStreamPart<ToolSet> {
  return {
    type: "finish",
    finishReason: "stop",
    rawFinishReason: "stop",
    totalUsage: {
      inputTokenDetails: { cacheReadTokens: 2, cacheWriteTokens: 1, noCacheTokens: 1 },
      inputTokens: 4,
      outputTokenDetails: { reasoningTokens: 3, textTokens: 3 },
      outputTokens: 6,
      totalTokens: 10,
    },
  };
}

export async function drain<T>(stream: ReadableStream<T>): Promise<readonly T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

export async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
