import { createServer as createBaseServer } from "@aio-proxy/server";
import { ProviderProtocol } from "@aio-proxy/types";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, expectedModel, expectedModelList, noModelsDevCatalog } from "./server.test-support";

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

  test("GET /health returns ok status and version when requested", async () => {
    // Given
    const app = await createServer({ config });

    // When
    const response = await app.request("/health");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "ok" });
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.version).toBe("string");
  });

  test("Given configured providers When OpenAI models are requested Then model list is returned", async () => {
    // Given
    const app = await createServer({ config, modelsDevCatalogTask: noModelsDevCatalog });

    // When
    const response = await app.request("/v1/models");
    const body = await response.json();

    // Then
    expect(response.status).toBe(200);
    expect(body).toEqual(
      expectedModelList([
        expectedModel("gpt-alias", "openai-compatible"),
        expectedModel("gpt-test", "openai-compatible"),
        expectedModel("compatible", "compatible"),
        expectedModel("compatible-test", "compatible"),
      ]),
    );
  });

  test("Given API and AI SDK providers with models only When models are requested Then every model is listed", async () => {
    const app = await createServer({
      modelsDevCatalogTask: noModelsDevCatalog,
      config: {
        providers: {
          api: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://api.example.com/v1",
            models: ["api-model"],
          },
          sdk: {
            kind: "ai-sdk",
            packageName: "@ai-sdk/openai-compatible",
            options: { baseURL: "https://sdk.example.com/v1", name: "sdk" },
            models: ["sdk-model"],
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expectedModelList([expectedModel("api-model", "api"), expectedModel("sdk-model", "sdk")]),
    );
  });

  test("Given added Anthropic aliases When models are requested Then upstream targets are hidden", async () => {
    const app = await createServer({
      modelsDevCatalogTask: noModelsDevCatalog,
      config: {
        providers: {
          "anthropic-aliases": {
            kind: "api",
            protocol: ProviderProtocol.Anthropic,
            baseURL: "https://anthropic.example.com",
            models: ["upstream-opus-48", "upstream-opus-46", "upstream-sonnet-46"],
            alias: {
              "claude-opus-4-8": "upstream-opus-48",
              "claude-opus-4-6": "upstream-opus-46",
              "claude-sonnet-4-6": "upstream-sonnet-46",
            },
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(
      expectedModelList([
        expectedModel("claude-opus-4-8", "anthropic-aliases"),
        expectedModel("claude-opus-4-6", "anthropic-aliases"),
        expectedModel("claude-sonnet-4-6", "anthropic-aliases"),
      ]),
    );
  });

  test("Given alias metadata without a name When models are requested Then the upstream name is used", async () => {
    const app = await createServer({
      modelsDevCatalogTask: async () => ({
        displayName: () => undefined,
        find: () => undefined,
        metadata(modelId) {
          return {
            "friendly-alias": { maxInputTokens: 100, maxTokens: 10 },
            "upstream-model": { displayName: "Upstream Model", maxInputTokens: 200, maxTokens: 20 },
          }[modelId];
        },
      }),
      config: {
        providers: {
          api: {
            kind: "api",
            protocol: ProviderProtocol.OpenAICompatible,
            baseURL: "https://api.example.com/v1",
            models: ["upstream-model"],
            alias: { "friendly-alias": "upstream-model" },
          },
        },
      },
    });

    const response = await app.request("/v1/models");

    expect(await response.json()).toEqual(
      expectedModelList([
        expectedModel("friendly-alias", "api", "Upstream Model", {
          maxInputTokens: 100,
          maxTokens: 10,
        }),
      ]),
    );
  });
});
