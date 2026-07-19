import { createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../../src/server-state";
import { cleanup, deferred, seedOAuthAccount, waitUntil } from "./test-support";

afterEach(cleanup);

test("removing an OAuth account during discovery discards the late catalog and cannot resurrect the provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-remove-during-discovery-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, "missing");
  const discoveryStarted = deferred();
  const releaseDiscovery = deferred<{
    language: { id: string }[];
    image: never[];
    embedding: never[];
    speech: never[];
    transcription: never[];
    reranking: never[];
  }>();
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
          discoveryStarted.resolve();
          return releaseDiscovery.promise;
        },
      },
      async createRuntime() {
        throw new Error("must not run without a catalog");
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    pluginLogger: () => {},
  });

  try {
    await discoveryStarted.promise;
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    expect(await state.reload()).toMatchObject({ ok: true });
    expect(state.currentProviderSnapshot().providers).toEqual([]);
    expect(() => state.currentProviderSnapshot().router.resolve("model")).toThrow();

    releaseDiscovery.resolve({
      language: [{ id: "model" }],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    await waitUntil(() => repository.readAccount("person") === null);
    await Bun.sleep(20);

    expect(repository.readCatalog("person")).toBeNull();
    expect(state.currentProviderSnapshot().providers).toEqual([]);
    expect(() => state.currentProviderSnapshot().router.resolve("model")).toThrow();
  } finally {
    releaseDiscovery.resolve({
      language: [],
      image: [],
      embedding: [],
      speech: [],
      transcription: [],
      reranking: [],
    });
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
