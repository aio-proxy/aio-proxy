import { describe, expect, test } from "bun:test";
import {
  BUNDLED_PROVIDERS,
  type BundledAiSdkProviderPackage,
  loadAiSdkProvider,
} from "../../src/index";

type ExpectedProvider = {
  readonly packageName: BundledAiSdkProviderPackage;
  readonly options: Record<string, string>;
  readonly methods: readonly string[];
};

const expectedProviders: readonly ExpectedProvider[] = [
  {
    packageName: "@ai-sdk/openai",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat", "responses"],
  },
  {
    packageName: "@ai-sdk/anthropic",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat"],
  },
  {
    packageName: "@ai-sdk/google",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat"],
  },
  {
    packageName: "@ai-sdk/openai-compatible",
    options: {
      apiKey: "test",
      baseURL: "https://example.invalid/v1",
      name: "test",
    },
    methods: ["languageModel"],
  },
  {
    packageName: "@ai-sdk/mistral",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat"],
  },
  {
    packageName: "@ai-sdk/groq",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat"],
  },
  {
    packageName: "@ai-sdk/xai",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat", "responses"],
  },
  {
    packageName: "@openrouter/ai-sdk-provider",
    options: { apiKey: "test" },
    methods: ["languageModel", "chat"],
  },
];

describe("loadAiSdkProvider", () => {
  test("loads every bundled provider factory without network calls", async () => {
    expect(Object.keys(BUNDLED_PROVIDERS).sort()).toEqual(
      expectedProviders.map((provider) => provider.packageName).sort(),
    );

    for (const expected of expectedProviders) {
      const provider = await loadAiSdkProvider(
        expected.packageName,
        expected.options,
      );

      expect(provider).not.toBeNull();
      for (const method of expected.methods) {
        expect(typeof provider?.[method]).toBe("function");
      }
    }
  });

  test("returns null for an unknown package", async () => {
    const provider = await loadAiSdkProvider("@ai-sdk/not-installed", {
      apiKey: "test",
    });

    expect(provider).toBeNull();
  });
});
