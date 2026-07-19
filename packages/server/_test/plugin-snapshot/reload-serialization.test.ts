import { createPluginRepository, Router } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { definePlugin, zod } from "@aio-proxy/plugin-sdk";
import { ConfigSchema } from "@aio-proxy/types";
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../../src/server-state";
import { cleanup, seedOAuthAccount } from "./test-support";

afterEach(cleanup);

test("overlapping slow and fast reloads commit in serialized file-read order", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-overlapping-reload-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      person: {
        kind: "oauth",
        plugin: "@example/oauth",
        capability: "default",
        options: { marker: "initial" },
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  handle.close();
  let markSlowStarted = () => {};
  const slowStarted = new Promise<void>((resolve) => {
    markSlowStarted = resolve;
  });
  let releaseSlow = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const created: string[] = [];
  const descriptor = definePlugin((api) => {
    api.oauth.register({
      id: "default",
      label: "Example",
      account: {
        options: { schema: zod.object({ marker: zod.string() }), form: [] },
      },
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
      async createRuntime({ options }) {
        const marker = (options as { marker: string }).marker;
        created.push(marker);
        if (marker === "slow") {
          markSlowStarted();
          await slowGate;
        }
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
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  });

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          person: {
            kind: "oauth",
            plugin: "@example/oauth",
            capability: "default",
            options: { marker: "slow" },
          },
        },
      }),
    );
    const slowReload = state.reload();
    await slowStarted;
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          person: {
            kind: "oauth",
            plugin: "@example/oauth",
            capability: "default",
            options: { marker: "fast" },
          },
        },
      }),
    );
    const fastReload = state.reload();
    releaseSlow();

    expect(await slowReload).toMatchObject({ ok: true });
    expect(await fastReload).toMatchObject({ ok: true });
    expect(state.currentConfig().providers[0]).toMatchObject({ options: { marker: "fast" } });
    expect(created).toEqual(["initial", "slow", "fast"]);
  } finally {
    releaseSlow();
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed candidate preserves the prior snapshot and never starts its catalog job", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-failed-candidate-"));
  const configPath = join(home, "config.json");
  const initialInput = {
    providers: {
      stable: {
        kind: "api",
        protocol: "openai-compatible",
        baseURL: "https://stable.example.test/v1",
        models: ["stable-model"],
      },
    },
  };
  writeFileSync(configPath, JSON.stringify(initialInput));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository, "missing");
  handle.close();
  let discoveries = 0;
  let routerBuilds = 0;
  let jobReplacements = 0;
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
          discoveries++;
          return {
            language: [{ id: "model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          };
        },
      },
      async createRuntime() {
        throw new Error("catalog is unavailable");
      },
    });
  });
  const state = await createServerState({
    config: ConfigSchema.parse(initialInput),
    configPath,
    watchConfig: false,
    dbHome: home,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
    logger: () => {},
    __test: {
      createRouter(providers: never[]) {
        routerBuilds++;
        if (routerBuilds === 2) throw new Error("candidate finalization failed");
        return new Router(providers);
      },
      onCatalogJobsReplaced() {
        jobReplacements++;
      },
    },
  } as never);
  const before = state.currentProviderSnapshot();

  try {
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          stable: {
            kind: "api",
            protocol: "openai-compatible",
            baseURL: "https://stable.example.test/v1",
            models: ["stable-model"],
          },
          person: {
            kind: "oauth",
            plugin: "@example/oauth",
            capability: "default",
          },
        },
      }),
    );
    const result = await state.reload();
    await Bun.sleep(20);

    expect(result).toMatchObject({ ok: false, stage: "providers" });
    expect(state.currentProviderSnapshot()).toBe(before);
    expect(jobReplacements).toBe(1);
    expect(discoveries).toBe(0);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});
