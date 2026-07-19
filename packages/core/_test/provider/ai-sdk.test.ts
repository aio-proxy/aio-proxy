import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV3 } from "@ai-sdk/provider";
import type { ModelMessage, TextStreamPart, ToolSet } from "ai";

import { describe, expect, test } from "bun:test";

import { createAiSdkProvider } from "../../src/index";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

const messages: ModelMessage[] = [{ role: "user", content: "hello" }];

async function collect(stream: ReadableStream<TextStreamPart<ToolSet>>): Promise<readonly TextStreamPart<ToolSet>[]> {
  const parts: TextStreamPart<ToolSet>[] = [];
  for await (const part of stream) {
    parts.push(part);
  }

  return parts;
}

function textPartStream(parts: readonly LanguageModelV2StreamPart[]): ReadableStream<LanguageModelV2StreamPart> {
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
  const availableProvider = {
    languageModel() {
      throw new Error("languageModel should not be called by ensureAvailable");
    },
  } satisfies Pick<ProviderV3, "languageModel">;

  test("defaults openai-compatible name to the provider id", async () => {
    let optionsSeen: Readonly<Record<string, unknown>> | undefined;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "carpool",
        packageName: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.test/v1" },
      },
      {
        async loadProvider(_packageName, options) {
          optionsSeen = options;
          return availableProvider;
        },
      },
    );

    await provider.ensureAvailable?.();
    expect(optionsSeen).toEqual({ baseURL: "https://example.test/v1", name: "carpool" });
  });

  test("preserves an explicit openai-compatible name", async () => {
    let optionsSeen: Readonly<Record<string, unknown>> | undefined;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "carpool",
        packageName: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://example.test/v1", name: "custom" },
      },
      {
        async loadProvider(_packageName, options) {
          optionsSeen = options;
          return availableProvider;
        },
      },
    );

    await provider.ensureAvailable?.();
    expect(optionsSeen).toEqual({ baseURL: "https://example.test/v1", name: "custom" });
  });

  test("rejects an explicit non-string openai-compatible name without replacing it", async () => {
    const provider = createAiSdkProvider({
      kind: "ai-sdk",
      id: "carpool",
      packageName: "@ai-sdk/openai-compatible",
      options: { baseURL: "https://example.test/v1", name: 42 },
    });

    if (!provider.ensureAvailable) {
      throw new Error("AI SDK provider should expose availability validation");
    }

    await expect(provider.ensureAvailable()).rejects.toThrow(
      "carpool: @ai-sdk/openai-compatible requires name and baseURL",
    );
  });

  test("does not inject name into other AI SDK packages", async () => {
    let optionsSeen: Readonly<Record<string, unknown>> | undefined;
    const provider = createAiSdkProvider(
      { kind: "ai-sdk", id: "openai", packageName: "@ai-sdk/openai", options: { apiKey: "test" } },
      {
        async loadProvider(_packageName, options) {
          optionsSeen = options;
          return availableProvider;
        },
      },
    );

    await provider.ensureAvailable?.();
    expect(optionsSeen).toEqual({ apiKey: "test" });
  });

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

    const parts = await collect(provider.invoke({ messages, modelId: "mock-model" }));

    expect(parts.filter((part) => part.type.startsWith("text"))).toEqual([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "hi" },
      { type: "text-end", id: "text-1" },
    ]);
  });

  test("moves system messages into AI SDK instructions", async () => {
    let promptSeen: unknown;
    const model = {
      specificationVersion: "v2",
      provider: "mock",
      modelId: "mock-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream(options) {
        promptSeen = options.prompt;
        return {
          stream: textPartStream([
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "ok" },
            { type: "text-end", id: "text-1" },
          ]),
        };
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

    await collect(
      provider.invoke({
        messages: [
          { role: "system", content: "Be brief." },
          { role: "user", content: "hello" },
        ],
        modelId: "mock-model",
      }),
    );

    expect(promptSeen).toEqual([
      { role: "system", content: "Be brief.", providerOptions: undefined },
      { role: "user", content: [{ type: "text", text: "hello" }], providerOptions: undefined },
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

    await expect(collect(provider.invoke({ messages, modelId: "mock-model" }))).rejects.toThrow(
      /mock-ai-sdk.*upstream exploded/,
    );
  });

  test("Given bundled ai-sdk provider When invoked Then loader provider receives the routed model id", async () => {
    // Given
    let packageSeen: string | undefined;
    let modelSeen: string | undefined;
    const model = {
      specificationVersion: "v2",
      provider: "mock",
      modelId: "routed-model",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "ok" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const loadedProvider = {
      languageModel(modelId: string) {
        modelSeen = modelId;
        return model;
      },
    } satisfies Pick<ProviderV3, "languageModel">;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "mock-ai-sdk",
        packageName: "@ai-sdk/openai",
        models: ["routed-model"],
        alias: { "alias-model": { model: "routed-model", preserve: false } },
      },
      {
        async loadProvider(packageName) {
          packageSeen = packageName;
          return loadedProvider;
        },
      },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "routed-model" }));

    // Then
    expect(packageSeen).toBe("@ai-sdk/openai");
    expect(modelSeen).toBe("routed-model");
    expect(parts.filter((part) => part.type === "text-delta")).toEqual([
      { type: "text-delta", id: "text-1", text: "ok" },
    ]);
  });

  test("Given uninstalled ai-sdk package When invoked Then request fails with install hint", async () => {
    // Given
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "missing-provider",
        packageName: "@vendor/missing-provider",
        models: ["missing-model"],
      },
      {
        async loadProvider() {
          return null;
        },
      },
    );

    // When / Then
    await expect(collect(provider.invoke({ messages, modelId: "missing-model" }))).rejects.toThrow(
      "run aio-proxy provider install @vendor/missing-provider",
    );
  });

  test("Given DeepSeek openai-compatible raw reasoning chunk When invoked Then reasoning delta is surfaced", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "deepseek-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "think first" } }],
              },
            },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "deepseek",
        packageName: "@ai-sdk/openai-compatible",
        options: { name: "deepseek" },
        models: ["deepseek-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "deepseek-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      {
        type: "reasoning-delta",
        id: "reasoning-aio-proxy",
        text: "think first",
      },
    ]);
  });

  test("Given DeepSeek stream has native and raw reasoning When invoked Then reasoning is not duplicated", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "deepseek-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "think once" } }],
              },
            },
            { type: "reasoning-start", id: "reason-1" },
            { type: "reasoning-delta", id: "reason-1", delta: "think once" },
            { type: "reasoning-end", id: "reason-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "deepseek",
        packageName: "@ai-sdk/openai-compatible",
        options: { name: "deepseek" },
        models: ["deepseek-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "deepseek-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", id: "reason-1", text: "think once" },
    ]);
  });

  test("Given chunked DeepSeek stream has native and raw reasoning When invoked Then reasoning is emitted once", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "deepseek-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "think " } }],
              },
            },
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "once" } }],
              },
            },
            { type: "reasoning-start", id: "reason-1" },
            { type: "reasoning-delta", id: "reason-1", delta: "think " },
            { type: "reasoning-delta", id: "reason-1", delta: "once" },
            { type: "reasoning-end", id: "reason-1" },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "deepseek",
        packageName: "@ai-sdk/openai-compatible",
        options: { name: "deepseek" },
        models: ["deepseek-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "deepseek-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", id: "reason-1", text: "think " },
      { type: "reasoning-delta", id: "reason-1", text: "once" },
    ]);
  });

  test("Given parseReasoningContent true for openai-compatible model When invoked Then raw reasoning is surfaced", async () => {
    // Given
    const model = {
      specificationVersion: "v2",
      provider: "openai-compatible",
      modelId: "custom-reasoner",
      supportedUrls: {},
      async doGenerate() {
        throw new Error("doGenerate should not be called");
      },
      async doStream() {
        return {
          stream: textPartStream([
            {
              type: "raw",
              rawValue: {
                choices: [{ delta: { reasoning_content: "custom thought" } }],
              },
            },
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: "answer" },
            { type: "text-end", id: "text-1" },
          ]),
        };
      },
    } satisfies LanguageModelV2;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "compatible",
        packageName: "@ai-sdk/openai-compatible",
        parseReasoningContent: true,
        models: ["custom-reasoner"],
      },
      { resolveModel: () => model },
    );

    // When
    const parts = await collect(provider.invoke({ messages, modelId: "custom-reasoner" }));

    // Then
    expect(parts.filter((part) => part.type === "reasoning-delta")).toEqual([
      {
        type: "reasoning-delta",
        id: "reasoning-aio-proxy",
        text: "custom thought",
      },
    ]);
  });
});
