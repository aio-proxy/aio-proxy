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
    expect(optionsSeen?.["baseURL"]).toBe("https://example.test/v1");
    expect(optionsSeen?.["name"]).toBe("carpool");
    expect(typeof optionsSeen?.["fetch"]).toBe("function");
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
    expect(optionsSeen?.["baseURL"]).toBe("https://example.test/v1");
    expect(optionsSeen?.["name"]).toBe("custom");
    expect(typeof optionsSeen?.["fetch"]).toBe("function");
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
    expect(optionsSeen?.["apiKey"]).toBe("test");
    expect(optionsSeen?.["name"]).toBeUndefined();
    expect(typeof optionsSeen?.["fetch"]).toBe("function");
  });

  test("forwards injected fetch and wins over serializable options.fetch", async () => {
    let decompressSeen: boolean | undefined;
    let acceptEncodingSeen: string | null = null;
    const providerFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      acceptEncodingSeen = new Request(input, init).headers.get("accept-encoding");
      decompressSeen = (init as { decompress?: boolean } | undefined)?.decompress;
      return new Response("ok");
    }) as ProviderFetch;
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
    expect(optionsSeen?.fetch).not.toBe(providerFetch);
    expect(typeof optionsSeen?.fetch).toBe("function");
    expect(optionsSeen?.apiKey).toBe("test");
    await (optionsSeen!.fetch as ProviderFetch)("https://example.test/v1", { method: "GET" });
    expect(decompressSeen).toBe(false);
    expect(acceptEncodingSeen).toBe("gzip, deflate, br, zstd");
  });

  test("leaves non-OpenAI package fetch identity unchanged", async () => {
    const providerFetch = (async () => new Response("ok")) as ProviderFetch;
    let optionsSeen: AiSdkProviderLoadOptions | undefined;
    const provider = createAiSdkProvider(
      { kind: "ai-sdk", id: "anthropic", packageName: "@ai-sdk/anthropic", options: { apiKey: "test" } },
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
