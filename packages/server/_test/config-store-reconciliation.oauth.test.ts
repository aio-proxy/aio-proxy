import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicConfigCommitUncertainError, AtomicConfigFile, createPluginRepository, Router } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createServerState } from "../src/server-state";
import { deferred, seedOAuthAccount, waitUntil } from "./config-store.oauth.test-support";
import { rawProvider } from "./pipeline-helpers";

describe("createConfigStore OAuth reconciliation", () => {
  test.each([
    ["committed bytes", true],
    ["uncommitted bytes", false],
  ])("server reconciliation converges %s after pre-verify uncertainty", async (_label, commitCandidate) => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-reconcile-"));
    const configPath = join(dir, "config.json");
    const initial = {
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    seedOAuthAccount(repository);
    const committedFile = new AtomicConfigFile(configPath);
    let releaseReconciliation = (): void => {};
    const reconciliationMayRun = new Promise<void>((resolve) => {
      releaseReconciliation = resolve;
    });
    let transactions = 0;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile["transaction"]>[0],
        options: Parameters<AtomicConfigFile["transaction"]>[1] = {},
      ): Promise<T> {
        transactions++;
        if (transactions <= 2) return committedFile.transaction(mutate, options) as Promise<T>;
        if (transactions === 3) {
          const { next } = await mutate(await committedFile.read());
          if (commitCandidate) writeFileSync(configPath, JSON.stringify(next));
          throw new AtomicConfigCommitUncertainError();
        }
        await reconciliationMayRun;
        return committedFile.transaction(mutate, options) as Promise<T>;
      },
    } as AtomicConfigFile;
    const provider = rawProvider({ id: "person" }).provider;
    const state = await createServerState({
      config: ConfigSchema.parse(initial),
      configPath,
      watchConfig: false,
      pluginRepository: repository,
      providerInstances: [provider],
      __test: { configFile: uncertainFile },
    } as never);
    const lease = state.acquireProviderSnapshot();

    try {
      await expect(state.configStore.deleteProvider("person")).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      expect(state.currentConfig().providers.map(({ id }) => id)).toEqual(["person"]);
      expect(repository.readAccount("person")).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      releaseReconciliation();
      await waitUntil(() => state.currentConfig().providers.some(({ id }) => id === "person") === !commitCandidate);
      expect(repository.readAccount("person")).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      lease.release();
      await waitUntil(() => repository.listPendingAccountOperations().length === 0);
      expect(repository.readAccount("person") === null).toBe(commitCandidate);
    } finally {
      releaseReconciliation();
      lease.release();
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server reconciliation preserves its marker and retries after a failed snapshot build", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-reconcile-retry-"));
    const configPath = join(dir, "config.json");
    const initial = {
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));
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
        if (transactions !== 3) return committedFile.transaction(mutate, options) as Promise<T>;
        const { next } = await mutate(await committedFile.read());
        writeFileSync(configPath, JSON.stringify(next));
        throw new AtomicConfigCommitUncertainError();
      },
    } as AtomicConfigFile;
    const firstReconciliationFailed = deferred();
    const reconciliationFailureReported = deferred();
    const reconciliationRetried = deferred();
    let routerBuilds = 0;
    const provider = rawProvider({ id: "person" }).provider;
    const state = await createServerState({
      config: ConfigSchema.parse(initial),
      configPath,
      watchConfig: false,
      pluginRepository: repository,
      providerInstances: [provider],
      logger: () => reconciliationFailureReported.resolve(),
      __test: {
        configFile: uncertainFile,
        reconciliationRetryMs: 50,
        createRouter(providers) {
          routerBuilds++;
          if (routerBuilds === 2) {
            firstReconciliationFailed.resolve();
            throw new Error("transient router failure");
          }
          if (routerBuilds === 3) reconciliationRetried.resolve();
          return new Router(providers);
        },
      },
    } as never);
    const lease = state.acquireProviderSnapshot();

    try {
      await expect(state.configStore.deleteProvider("person")).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      await firstReconciliationFailed.promise;
      await reconciliationFailureReported.promise;
      expect(state.currentConfig().providers.map(({ id }) => id)).toEqual(["person"]);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      await Bun.sleep(10);
      expect(routerBuilds).toBe(2);
      await reconciliationRetried.promise;
      expect(routerBuilds).toBe(3);
      await waitUntil(() => state.currentConfig().providers.length === 0);
      expect(state.currentConfig().providers).toEqual([]);
      expect(repository.readAccount("person")).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      lease.release();
      await waitUntil(() => repository.listPendingAccountOperations().length === 0);
      expect(repository.readAccount("person")).toBeNull();
    } finally {
      lease.release();
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("server close cancels a delayed reconciliation retry without an immediate failure loop", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-reconcile-close-"));
    const configPath = join(dir, "config.json");
    const initial = {
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));
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
        if (transactions !== 3) return committedFile.transaction(mutate, options) as Promise<T>;
        const { next } = await mutate(await committedFile.read());
        writeFileSync(configPath, JSON.stringify(next));
        throw new AtomicConfigCommitUncertainError();
      },
    } as AtomicConfigFile;
    const firstReconciliationFailed = deferred();
    const secondReconciliationFailed = deferred();
    const reconciliationFailureReported = deferred();
    const retryFailureReported = deferred();
    let reportedFailures = 0;
    let routerBuilds = 0;
    const state = await createServerState({
      config: ConfigSchema.parse(initial),
      configPath,
      watchConfig: false,
      pluginRepository: repository,
      providerInstances: [rawProvider({ id: "person" }).provider],
      logger: () => {
        reportedFailures++;
        if (reportedFailures === 1) reconciliationFailureReported.resolve();
        if (reportedFailures === 2) retryFailureReported.resolve();
      },
      __test: {
        configFile: uncertainFile,
        reconciliationRetryMs: 50,
        createRouter(providers) {
          routerBuilds++;
          if (routerBuilds > 1) {
            if (routerBuilds === 2) firstReconciliationFailed.resolve();
            if (routerBuilds === 3) secondReconciliationFailed.resolve();
            throw new Error("persistent router failure");
          }
          return new Router(providers);
        },
      },
    } as never);

    try {
      await expect(state.configStore.deleteProvider("person")).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      await firstReconciliationFailed.promise;
      await reconciliationFailureReported.promise;
      expect(routerBuilds).toBe(2);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      await Bun.sleep(10);
      expect(routerBuilds).toBe(2);
      await secondReconciliationFailed.promise;
      await retryFailureReported.promise;
      expect(routerBuilds).toBe(3);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);

      await Bun.sleep(10);
      expect(routerBuilds).toBe(3);
      state.close();
      await Bun.sleep(75);
      expect(routerBuilds).toBe(3);
      expect(repository.listPendingAccountOperations()).toHaveLength(1);
    } finally {
      state.close();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
