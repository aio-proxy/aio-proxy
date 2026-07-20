import type { ModelsDevCatalog } from "@aio-proxy/core";

import { createServer as createBaseServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loopbackServer } from "../src/dashboard-auth/test-support";
import { expectedModel, expectedModelList, noModelsDevCatalog, testCapabilities } from "./server.test-support";

describe("server routes", () => {
  let dir: string;
  const createServer = (options: Parameters<typeof createBaseServer>[0]) =>
    createBaseServer({ ...options, dbHome: dir });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aio-proxy-server-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("Given duplicate models When models are requested Then the highest-weight provider owns each id", async () => {
    const catalog: ModelsDevCatalog = {
      displayName(modelId) {
        return {
          "claude-sonnet-4-6": "Claude Sonnet 4.6",
          "gpt-only": "GPT Only",
          shared: "Shared Model",
        }[modelId];
      },
      find() {
        return undefined;
      },
      metadata(modelId) {
        return {
          "claude-sonnet-4-6": {
            capabilities: testCapabilities,
            displayName: "Claude Sonnet 4.6",
            maxInputTokens: 1_000_000,
            maxTokens: 128_000,
            releaseDate: "2026-01-15",
          },
          "gpt-only": { displayName: "GPT Only", releaseDate: "2026-02-30" },
          shared: { displayName: "Shared Model" },
        }[modelId];
      },
    };
    const app = await createServer({
      modelsDevCatalogTask: async () => catalog,
      config: {
        providers: {
          low: {
            kind: "api",
            weight: 1,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://low.example.com",
            models: ["shared", "gpt-only"],
          },
          high: {
            kind: "api",
            weight: 10,
            protocol: ProviderProtocol.Anthropic,
            baseURL: "https://high.example.com",
            models: ["opaque-claude", "shared"],
            alias: { "claude-sonnet-4-6": "opaque-claude" },
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(await response.json()).toEqual(
      expectedModelList([
        expectedModel("claude-sonnet-4-6", "high", "Claude Sonnet 4.6", {
          capabilities: testCapabilities,
          created: 1_768_435_200,
          createdAt: "2026-01-15T00:00:00.000Z",
          maxInputTokens: 1_000_000,
          maxTokens: 128_000,
        }),
        expectedModel("shared", "high", "Shared Model"),
        expectedModel("gpt-only", "low", "GPT Only"),
      ]),
    );
  });

  test("Given equal provider weights When models are requested Then configuration order breaks ties", async () => {
    const app = await createServer({
      modelsDevCatalogTask: noModelsDevCatalog,
      config: {
        providers: {
          first: {
            kind: "api",
            weight: 5,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://first.example.com",
            models: ["shared"],
          },
          second: {
            kind: "api",
            weight: 5,
            protocol: ProviderProtocol.Anthropic,
            baseURL: "https://second.example.com",
            models: ["shared"],
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(await response.json()).toEqual(expectedModelList([expectedModel("shared", "first")]));
  });

  test("Given models.dev failure When models are requested Then ids remain valid display names", async () => {
    const app = await createServer({
      modelsDevCatalogTask: async () => {
        throw new Error("catalog unavailable");
      },
      config: {
        providers: {
          api: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://api.example.com",
            models: ["plain-model"],
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(await response.json()).toEqual(expectedModelList([expectedModel("plain-model", "api")]));
  });

  test("Given disabled provider When models and dashboard are requested Then provider is not routed", async () => {
    // Given
    const app = await createServer({
      config: {
        providers: {
          openai: {
            kind: "api",
            enabled: false,
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://api.example.com",
            models: ["gpt-disabled", "gpt-untouched"],
            alias: { disabled: { model: "gpt-disabled", preserve: false } },
          },
        },
      },
    });

    // When
    const models = await app.request("/v1/models");
    const providers = await app.request("/dashboard/api/providers", undefined, loopbackServer);

    // Then
    expect(await models.json()).toEqual(expectedModelList([]));
    expect(await providers.json()).toEqual({
      providers: [
        {
          id: "openai",
          kind: "api",
          enabled: false,
          passthrough: true,
          last_status: "unknown",
          last_latency: null,
          clientModels: ["disabled", "gpt-untouched"],
          hasApiKey: false,
          state: { status: "ready" },
        },
      ],
    });
  });
});
