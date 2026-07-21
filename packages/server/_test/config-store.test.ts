import { parseRuntimeConfig } from "@aio-proxy/core";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigReloadRejectedError, createConfigStore } from "../src/config-store";
import { createServerState } from "../src/server-state";

describe("createConfigStore mutex", () => {
  test("a rejected write does not poison later mutations", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }, null, 2));

    let reloads = 0;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      verify: async () => {
        reloads += 1;
      },
    });

    await expect(
      store.mutateProviders(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    await store.mutateProviders((record) => ({ ...record, added: { kind: "api" } }));

    const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(onDisk.providers.added).toEqual({ kind: "api" });
    expect(reloads).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects and rolls back to the prior config when reload reports failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    const original = JSON.stringify({ providers: { a: { kind: "api" } } }, null, 2);
    writeFileSync(configPath, original);

    const store = createConfigStore({
      getConfigPath: () => configPath,
      verify: async () => {
        throw new Error("invalid alias target");
      },
    });

    await expect(store.mutateProviders((record) => ({ ...record, b: { kind: "api" } }))).rejects.toThrow(
      ConfigReloadRejectedError,
    );

    expect(readFileSync(configPath, "utf8")).toBe(original);

    rmSync(dir, { recursive: true, force: true });
  });

  test("Given a restrictive config mode When providers are mutated Then the rewritten file preserves it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-"));
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, JSON.stringify({ providers: {} }, null, 2));
    chmodSync(configPath, 0o600);
    const store = createConfigStore({
      getConfigPath: () => configPath,
      verify: async () => undefined,
    });

    await store.mutateProviders((record) => ({ ...record, added: { kind: "api" } }));
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("config-store runtime materialization", () => {
  test("Given authored env templates When an unrelated provider field is mutated Then the file keeps templates while runtime config resolves them", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-templates-"));
    const configPath = join(dir, "config.json");
    const authored = {
      proxy: "{{env.GLOBAL_PROXY}}",
      providers: {
        api: {
          kind: "api",
          protocol: "openai-response",
          baseURL: "https://api.example/v1",
          headers: { Authorization: "Bearer {{env.UPSTREAM_TOKEN}}" },
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(authored, null, 2));
    const previousProxy = process.env["GLOBAL_PROXY"];
    const previousToken = process.env["UPSTREAM_TOKEN"];
    process.env["GLOBAL_PROXY"] = "https://proxy.example:8443";
    process.env["UPSTREAM_TOKEN"] = "secret-token";

    const state = await createServerState({ config: parseRuntimeConfig(authored), configPath });
    try {
      await state.configStore.mutateProviders((record) => ({
        ...record,
        api: { ...(record["api"] as Record<string, unknown>), weight: 5 },
      }));

      const onDisk = JSON.parse(readFileSync(configPath, "utf8")) as typeof authored;
      expect(onDisk.proxy).toBe("{{env.GLOBAL_PROXY}}");
      expect(onDisk.providers.api.headers.Authorization).toBe("Bearer {{env.UPSTREAM_TOKEN}}");

      const currentConfig = state.currentConfig();
      expect(currentConfig.proxy).toBe("https://proxy.example:8443");
      expect(currentConfig.providers[0]).toMatchObject({
        headers: { Authorization: "Bearer secret-token" },
        weight: 5,
      });
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
      if (previousProxy === undefined) delete process.env["GLOBAL_PROXY"];
      else process.env["GLOBAL_PROXY"] = previousProxy;
      if (previousToken === undefined) delete process.env["UPSTREAM_TOKEN"];
      else process.env["UPSTREAM_TOKEN"] = previousToken;
    }
  });
});
