import type { LanguageModelV2, LanguageModelV2StreamPart, ProviderV3 } from "@ai-sdk/provider";

import { describe, expect, test } from "bun:test";

import { createAiSdkProvider } from "../../index";
import { collect, messages, textPartStream } from "./ai-sdk-test-helpers";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

describe("createAiSdkProvider stream", () => {
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
});
