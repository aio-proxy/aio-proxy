import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository, geminiGenerateContentAdapter } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, type ModelCatalog, type OAuthAdapter, type RawResolver, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema, ProviderProtocol } from "@aio-proxy/types";
import { handleProtocolRequest } from "../src/routes/pipeline";
import { createServerState } from "../src/server-state";

const antigravityPackage = "@aio-proxy/plugin-google-antigravity";

test("orders Antigravity accounts by Provider weight and preserves equal-weight config order", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-provider-ordering-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  for (const providerId of ["antigravity-high", "antigravity-equal-first"]) {
    seedAccount(repository, providerId, modelCatalog("shared"));
  }
  handle.close();
  const config = ConfigSchema.parse({
    providers: {
      "api-low": {
        kind: "api",
        weight: 1,
        protocol: ProviderProtocol.OpenAICompatible,
        baseURL: "https://api.example.test",
        models: ["shared"],
      },
      "antigravity-high": {
        kind: "oauth",
        weight: 10,
        plugin: antigravityPackage,
        capability: "default",
      },
      "antigravity-equal-first": {
        kind: "oauth",
        weight: 5,
        plugin: antigravityPackage,
        capability: "default",
      },
      "sdk-equal-second": {
        kind: "ai-sdk",
        weight: 5,
        packageName: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://sdk.example.test", name: "sdk-equal-second" },
        models: ["shared"],
      },
    },
  });
  const state = await createServerState({
    config,
    dbHome: home,
    builtIns: [{ packageName: antigravityPackage, version: "1.0.0", descriptor: oauthDescriptor() }],
  } as never);

  try {
    expect(state.currentProviderSnapshot().plugins.plugins.get(antigravityPackage)).toMatchObject({
      builtIn: true,
      state: { status: "ready" },
      version: "1.0.0",
    });
    expect(
      state
        .currentProviderSnapshot()
        .router.resolve("shared")
        .map(({ provider }) => provider.id),
    ).toEqual(["antigravity-high", "antigravity-equal-first", "sdk-equal-second", "api-low"]);
    expect(state.currentProviderSnapshot().providerStates?.get("api-low")).toEqual({ status: "ready" });
    expect(state.currentProviderSnapshot().providerStates?.get("sdk-equal-second")).toEqual({ status: "ready" });
    for (const providerId of ["antigravity-high", "antigravity-equal-first"]) {
      expect(state.currentProviderSnapshot().providerStates?.get(providerId)).toEqual({
        status: "ready",
        catalog: "fresh",
      });
    }
  } finally {
    state.close();
    rmSync(home, { force: true, recursive: true });
  }
});

test("attempts an existing alias after catalog refresh removes its target", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-provider-alias-refresh-"));
  const configPath = join(home, "config.json");
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedAccount(repository, "antigravity", modelCatalog("removed-from-catalog"));
  const configInput = {
    providers: {
      antigravity: {
        kind: "oauth",
        plugin: antigravityPackage,
        capability: "default",
        alias: { stable: { model: "removed-from-catalog", preserve: false } },
      },
    },
  } as const;
  writeFileSync(configPath, `${JSON.stringify(configInput)}\n`);
  const attempts: { readonly modelId: string; readonly path: string }[] = [];
  const state = await createServerState({
    config: ConfigSchema.parse(configInput),
    configPath,
    dbHome: home,
    pluginRepository: repository,
    watchConfig: false,
    builtIns: [
      {
        packageName: antigravityPackage,
        version: "1.0.0",
        descriptor: oauthDescriptor(async () =>
          runtime(({ protocol, modelId }) => {
            if (protocol !== "gemini") return undefined;
            return {
              invoke: async (request) => {
                attempts.push({ modelId, path: new URL(request.url).pathname });
                return Response.json({ candidates: [] });
              },
            };
          }),
        ),
      },
    ],
  } as never);

  try {
    expect(state.currentProviderSnapshot().providers[0]?.models).toContain("removed-from-catalog");
    repository.writeCatalog("antigravity", modelCatalog("replacement"), Date.now() + 1);
    expect(await state.reload()).toMatchObject({ ok: true });
    expect(state.currentProviderSnapshot().providers[0]?.models).not.toContain("removed-from-catalog");

    const response = await handleProtocolRequest({
      adapter: geminiGenerateContentAdapter,
      context: { model: "stable", stream: false },
      rawRequest: new Request("http://localhost/v1beta/models/stable:generateContent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hello" }] }] }),
      }),
      source: state,
    });

    expect(response.status).toBe(200);
    expect(attempts).toEqual([
      { modelId: "removed-from-catalog", path: "/v1beta/models/removed-from-catalog:generateContent" },
    ]);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { force: true, recursive: true });
  }
});

function modelCatalog(...models: string[]): ModelCatalog {
  return {
    language: models.map((id) => ({ id })),
    image: [],
    embedding: [],
    speech: [],
    transcription: [],
    reranking: [],
  };
}

function seedAccount(repository: ReturnType<typeof createPluginRepository>, providerId: string, catalog: ModelCatalog) {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: `create:${providerId}`,
    account: {
      providerId,
      plugin: antigravityPackage,
      capability: "default",
      fingerprint: `${providerId}@example.com`,
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: { kind: "replace", value: { catalog, refreshedAt: Date.now() } },
    },
  });
  repository.completeAccountOperation(operation.operationId);
}

function oauthDescriptor(createRuntime: OAuthAdapter["createRuntime"] = async () => runtime()) {
  return definePlugin((api) => {
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
      createRuntime,
    });
  });
}

function runtime(raw?: RawResolver) {
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
    ...(raw === undefined ? {} : { raw }),
  } as never;
}
