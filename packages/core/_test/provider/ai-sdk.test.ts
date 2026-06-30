import { describe, expect, test } from "bun:test";
import type {
  LanguageModelV2,
  LanguageModelV2StreamPart,
} from "@ai-sdk/provider";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";
import { createAiSdkProvider } from "../../src/index";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

async function collect(
  stream: ReadableStream<TextStreamPart<ToolSet>>,
): Promise<readonly TextStreamPart<ToolSet>[]> {
  const parts: TextStreamPart<ToolSet>[] = [];
  for await (const part of stream) {
    parts.push(part);
  }

  return parts;
}

function textPartStream(
  parts: readonly LanguageModelV2StreamPart[],
): ReadableStream<LanguageModelV2StreamPart> {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      controller.close();
    },
  });
}

describe("createAiSdkProvider", () => {
  test("yields the exact model-origin stream parts in order", async () => {
    const modelParts: readonly LanguageModelV2StreamPart[] = [
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", delta: "hi" },
      { type: "text-end", id: "text-1" },
    ];
    const model = {
      specificationVersion: "v2",
      provider: "mock",
      modelId: "mock-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return { stream: textPartStream(modelParts) };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "mock-ai-sdk",
        packageName: "@ai-sdk/openai",
        models: ["mock-model"],
      },
      { resolveModel: () => model },
    );

    const parts = await collect(provider.invoke(messages));

    expect(parts.filter((part) => part.type.startsWith("text"))).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "hi" },
      { type: "text-end", id: "text-1" },
    ]);
  });

  test("wraps model stream failures with the provider id", async () => {
    const model = {
      specificationVersion: "v2",
      provider: "mock",
      modelId: "mock-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        throw new Error("upstream exploded");
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "mock-ai-sdk",
        packageName: "@ai-sdk/openai",
        models: ["mock-model"],
      },
      { resolveModel: () => model },
    );

    await expect(collect(provider.invoke(messages))).rejects.toThrow(
      /mock-ai-sdk.*upstream exploded/,
    );
  });
});
