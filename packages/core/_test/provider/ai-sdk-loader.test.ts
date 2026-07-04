import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUNDLED_PROVIDERS,
  type BundledAiSdkProviderPackage,
  loadAiSdkProvider,
  npmPackageCacheDir,
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
      const provider = await loadAiSdkProvider(expected.packageName, expected.options);

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

  test("Given runtime package cached When bundled lookup misses Then provider factory imports from cache", async () => {
    // Given
    const home = mkdtempSync(join(tmpdir(), "aio-proxy-loader-home-"));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    const pkg = "aio-proxy-runtime-provider";
    const packageDir = join(npmPackageCacheDir(pkg), "node_modules", pkg);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: pkg, version: "1.0.0", main: "index.js" }));
    writeFileSync(
      join(packageDir, "index.js"),
      "export function createRuntimeProvider(options) { return { languageModel() { return options.apiKey; } }; }\n",
    );

    try {
      // When
      const provider = await loadAiSdkProvider(pkg, { apiKey: "test-key" });

      // Then
      expect(provider).not.toBeNull();
      expect(typeof provider?.languageModel).toBe("function");
    } finally {
      if (previousHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = previousHome;
      }
      rmSync(home, { recursive: true, force: true });
    }
  });
});
