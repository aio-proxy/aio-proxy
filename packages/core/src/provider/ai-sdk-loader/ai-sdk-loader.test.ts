import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ProviderFetch } from "../../index";

import {
  BUNDLED_PROVIDER_VERSIONS,
  BUNDLED_PROVIDERS,
  type BundledAiSdkProviderPackage,
  loadAiSdkProvider,
  npmPackageCacheDir,
} from "../../index";

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
  test("bundled provider versions match installed package metadata", async () => {
    const corePackageRoot = join(import.meta.dir, "../../..");
    expect(Object.keys(BUNDLED_PROVIDER_VERSIONS).sort()).toEqual(
      expectedProviders.map((provider) => provider.packageName).sort(),
    );

    for (const { packageName } of expectedProviders) {
      const manifest = await Bun.file(join(corePackageRoot, "node_modules", packageName, "package.json")).json();
      expect(BUNDLED_PROVIDER_VERSIONS[packageName]).toBe(manifest.version);
    }
  });

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

  test("forwards fetch into createOpenAICompatible instead of dropping it", async () => {
    const providerFetch = (async () => new Response("ok")) as ProviderFetch;
    let createOptions: { readonly fetch?: ProviderFetch } | undefined;

    mock.module("@ai-sdk/openai-compatible", () => ({
      createOpenAICompatible(options: { readonly fetch?: ProviderFetch }) {
        createOptions = options;
        return {
          languageModel() {
            throw new Error("languageModel should not be called");
          },
        };
      },
    }));

    try {
      const provider = await loadAiSdkProvider("@ai-sdk/openai-compatible", {
        apiKey: "test",
        baseURL: "https://example.invalid/v1",
        name: "test",
        fetch: providerFetch,
      });

      expect(provider).not.toBeNull();
      expect(createOptions?.fetch).toBe(providerFetch);
    } finally {
      mock.restore();
    }
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
