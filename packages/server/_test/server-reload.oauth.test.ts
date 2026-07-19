import { AtomicConfigFile, createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServerState } from "../src/server-state";
import { seedOAuthAccount, settleWatcher, waitUntil, writeConfig } from "./server-reload.oauth.test-support";

describe("server OAuth reload", () => {
  test("an uncertain reload commit keeps cleanup recoverable after the snapshot swaps", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-uncertain-"));
    const configPath = join(dir, "config.json");
    const initialConfig = {
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    };
    writeConfig(configPath, initialConfig);
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    const committedFile = new AtomicConfigFile(configPath);
    let transactions = 0;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile["transaction"]>[0],
        options: Parameters<AtomicConfigFile["transaction"]>[1] = {},
      ): Promise<T> {
        transactions++;
        if (transactions <= 2) return committedFile.transaction(mutate, options) as Promise<T>;
        await mutate(await committedFile.read());
        throw new Error("Config lock ownership lost");
      },
    } as AtomicConfigFile;
    const state = await createServerState({
      config: ConfigSchema.parse(initialConfig),
      configPath,
      pluginRepository: repository,
      watchConfig: false,
      logger: () => {},
      __test: { configFile: uncertainFile },
    } as never);

    try {
      writeConfig(configPath, { providers: {} });
      expect(await state.reload()).toMatchObject({ ok: false });
      expect(await state.providerSummaries({ probe: false })).toEqual([]);
      await waitUntil(() => repository.readAccount("person") === null);
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test.each([
    ["manual reload", false, { kind: "oauth", plugin: "@example/oauth", capability: "" }],
    ["watcher reload", true, { kind: "oauth", vendor: "legacy-provider" }],
  ])(
    "Given an invalid or legacy OAuth row When %s removes it Then account cleanup uses a CAS marker",
    async (_label, watchConfig, provider) => {
      const dir = mkdtempSync(join(tmpdir(), "aio-proxy-reload-oauth-delete-"));
      const configPath = join(dir, "config.jsonc");
      const initialConfig = { providers: { person: provider } };
      writeConfig(configPath, initialConfig);
      const handle = openDb({ home: dir });
      const repository = createPluginRepository(handle.sqlite);
      seedOAuthAccount(repository);
      const state = await createServerState({
        config: ConfigSchema.parse(initialConfig),
        configPath,
        pluginRepository: repository,
        watchConfig,
        logger: () => {},
      });

      try {
        if (watchConfig) await settleWatcher();
        writeConfig(configPath, { providers: {} });
        if (watchConfig) {
          await waitUntil(() => repository.readAccount("person") === null);
        } else {
          expect(await state.reload()).toMatchObject({ ok: true });
          await waitUntil(() => repository.readAccount("person") === null);
        }

        expect(repository.readAccount("person")).toBeNull();
        expect(repository.listPendingAccountOperations()).toEqual([]);
        expect(await state.reload()).toMatchObject({ ok: true });
      } finally {
        state.close();
        handle.close();
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
