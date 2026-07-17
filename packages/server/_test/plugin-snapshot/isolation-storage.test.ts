import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository, type PluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { createServerState } from "../../src/server-state";
import { cleanup, routedOAuthDescriptor, seedOAuthAccount } from "./test-support";

afterEach(cleanup);

test("corrupt stored plugin secret fails only that plugin and preserves healthy providers", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-corrupt-plugin-secret-"));
  const handle = openDb({ home });
  handle.sqlite
    .query("INSERT INTO plugin_secret (plugin, value_json, revision, updated_at) VALUES (?, ?, 1, ?)")
    .run("@example/broken", "{", Date.now());
  const repository = createPluginRepository(handle.sqlite);
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
      },
    }),
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/broken", version: "1.0.0", descriptor: definePlugin(() => {}) }],
    pluginLogger: () => {},
  });

  try {
    expect(state.currentProviderSnapshot().plugins.plugins.get("@example/broken")).toMatchObject({
      state: { status: "failed", diagnostic: { code: "PLUGIN_LOAD_FAILED" } },
    });
    expect(state.currentProviderSnapshot().router.resolve("stable-model")[0]?.provider.id).toBe("stable");
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test.each([
  ["account", "UPDATE oauth_account SET credential_json = '{' WHERE provider_id = 'broken'"],
  [
    "diagnostic",
    "INSERT INTO oauth_account_diagnostic (provider_id, code, diagnostic_json) VALUES ('broken', 'CREDENTIAL_REFRESH_FAILED', '{')",
  ],
  ["catalog", "UPDATE oauth_catalog SET catalog_json = '{' WHERE provider_id = 'broken'"],
])("a corrupt persisted %s read isolates one OAuth provider from healthy API, AI SDK, and plugin siblings", async (_kind, sql) => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-corrupt-provider-read-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, "ready", "broken");
  seedOAuthAccount(repository, "ready", "healthy-plugin");
  handle.sqlite.run(sql);
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        broken: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
        "healthy-plugin": { kind: "oauth", plugin: "@example/oauth", capability: "default" },
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
        sdk: {
          kind: "ai-sdk",
          packageName: "@ai-sdk/openai-compatible",
          options: { baseURL: "https://sdk.example.test/v1", name: "sdk" },
          models: ["sdk-model"],
        },
      },
    }),
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor: routedOAuthDescriptor() }],
    pluginLogger: () => {},
  });

  try {
    const summaries = await state.providerSummaries({ probe: false });
    const broken = summaries.find((summary) => summary.id === "broken");
    expect(broken?.state.status).toBe("unavailable");
    expect(
      state
        .currentProviderSnapshot()
        .router.resolve("model")
        .some(({ provider }) => provider.id === "healthy-plugin"),
    ).toBe(true);
    expect(state.currentProviderSnapshot().router.resolve("stable-model")[0]?.provider.id).toBe("stable");
    expect(state.currentProviderSnapshot().router.resolve("sdk-model")[0]?.provider.id).toBe("sdk");
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("plugin secret materialization reuses the captured read outcome without a racing second read", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-plugin-secret-race-"));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, "ready", "person");
  let reads = 0;
  const racingRepository: PluginRepository = {
    ...repository,
    readPluginSecret(plugin) {
      reads += 1;
      if (reads > 1) throw new Error(`racing second plugin secret read: ${plugin}`);
      return null;
    },
  };
  const state = await createServerState({
    config: ConfigSchema.parse({
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
      },
    }),
    pluginRepository: racingRepository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor: routedOAuthDescriptor() }],
    pluginLogger: () => {},
  });

  try {
    expect(reads).toBe(1);
    expect(state.currentProviderSnapshot().router.resolve("model")[0]?.provider.id).toBe("person");
    expect(state.currentProviderSnapshot().router.resolve("stable-model")[0]?.provider.id).toBe("stable");
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
