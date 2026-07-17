import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema, ProviderProtocol } from "@aio-proxy/types";
import { createServerState } from "../src/server-state";

test("preserves weight and config order across OAuth, AI SDK, and API providers", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-provider-ordering-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const create = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "oauth-high",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "oauth-high@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: {
        kind: "replace",
        value: {
          catalog: {
            language: [{ id: "shared" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  repository.completeAccountOperation(create.operationId);
  handle.close();
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: { options: { schema: zod.object({}), form: [] } },
      credentials: zod.object({ token: zod.string() }),
      async login() {
        throw new Error("not called");
      },
      catalog: {
        policy: { kind: "static" },
        async discover() {
          throw new Error("not called");
        },
      },
      async createRuntime() {
        return {
          provider: {
            specificationVersion: "v4",
            languageModel() {
              throw new Error("not called");
            },
            imageModel() {
              throw new Error("not called");
            },
            embeddingModel() {
              throw new Error("not called");
            },
          },
        } as never;
      },
    });
  });
  const config = ConfigSchema.parse({
    providers: {
      "api-low": {
        kind: "api",
        weight: 1,
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: "https://api.example.test",
        models: ["shared"],
      },
      "oauth-high": {
        kind: "oauth",
        weight: 10,
        plugin: "@example/oauth",
        capability: "default",
      },
      "sdk-mid": {
        kind: "ai-sdk",
        weight: 5,
        packageName: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://sdk.example.test", name: "sdk-mid" },
        models: ["shared"],
      },
    },
  });
  const state = await createServerState({
    config,
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  } as never);

  try {
    expect(state.currentProviderSnapshot().plugins.plugins.get("@example/oauth")).toMatchObject({
      builtIn: true,
      state: { status: "ready" },
      version: "1.0.0",
    });
    expect(
      state
        .currentProviderSnapshot()
        .router.resolve("shared")
        .map(({ provider }) => provider.id),
    ).toEqual(["oauth-high", "sdk-mid", "api-low"]);
    expect(state.currentProviderSnapshot().providerStates?.get("api-low")).toEqual({ status: "ready" });
    expect(state.currentProviderSnapshot().providerStates?.get("sdk-mid")).toEqual({ status: "ready" });
    expect(state.currentProviderSnapshot().providerStates?.get("oauth-high")).toEqual({
      status: "ready",
      catalog: "fresh",
    });
  } finally {
    state.close();
    rmSync(home, { force: true, recursive: true });
  }
});
