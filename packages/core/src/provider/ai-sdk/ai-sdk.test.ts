import type { LanguageModelV2, ProviderV3 } from "@ai-sdk/provider";

import { describe, expect, test } from "bun:test";

import type { AiSdkProviderLoadOptions, ProviderFetch } from "../../index";

import { createAiSdkProvider } from "../../index";
import { collect, messages } from "./ai-sdk-test-helpers";

Object.assign(globalThis, { AI_SDK_LOG_WARNINGS: false });

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

  test("forwards injected fetch and wins over serializable options.fetch", async () => {
    const providerFetch = (async () => new Response("ok")) as ProviderFetch;
    let optionsSeen: AiSdkProviderLoadOptions | undefined;
    const provider = createAiSdkProvider(
      {
        kind: "ai-sdk",
        id: "carpool",
        packageName: "@ai-sdk/openai",
        options: { apiKey: "test", fetch: "serializable-placeholder" },
      },
      {
        fetch: providerFetch,
        async loadProvider(_packageName, options) {
          optionsSeen = options;
          return availableProvider;
        },
      },
    );

    await provider.ensureAvailable?.();
    expect(optionsSeen?.fetch).toBe(providerFetch);
    expect(optionsSeen?.apiKey).toBe("test");
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
});
