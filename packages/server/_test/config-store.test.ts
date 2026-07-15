import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABSENT_PROVIDER_DIGEST,
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  createPluginRepository,
  PENDING_OPERATION_TTL_MS,
  type PluginRepository,
  Router,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createAccountRemovalCoordinator } from "../src/account-removal";
import { ConfigReloadRejectedError, createConfigStore } from "../src/config-store";
import { createServerState } from "../src/server-state";
import { rawProvider } from "./pipeline-helpers";

function seedOAuthAccount(repository: PluginRepository): void {
  const operation = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "secret" },
      catalog: {
        kind: "replace",
        value: {
          catalog: {
            language: [{ id: "model" }],
            image: [],
            embedding: [],
            speech: [],
            transcription: [],
            reranking: [],
          },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(operation.operationId);
  repository.writeDiagnostic("person", {
    code: "CREDENTIALS_MISSING_OR_INVALID",
    summary: "credential unavailable",
    retryable: false,
    occurredAt: new Date(0).toISOString(),
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(10);
  }
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("createConfigStore mutex", () => {
  test("a config mutation and concurrent reload share one FIFO without lock inversion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-lock-order-"));
    const configPath = join(dir, "config.json");
    const input = {
      providers: {
        stable: {
          kind: "api",
          protocol: "openai-compatible",
          baseURL: "https://stable.example.test/v1",
          models: ["stable-model"],
        },
      },
    };
    writeFileSync(configPath, JSON.stringify(input));
    const state = await createServerState({
      config: ConfigSchema.parse(input),
      configPath,
      watchConfig: false,
      dbHome: dir,
    });
    let concurrentReload: ReturnType<typeof state.reload> | undefined;

    try {
      const mutation = state.configStore.mutateProviders((providers) => {
        concurrentReload = state.reload();
        return providers;
      });
      const outcome = await Promise.race([
        mutation
          .then(async () => concurrentReload)
          .then(async (reload) => ({ kind: "completed" as const, reload: await reload })),
        Bun.sleep(2_000).then(() => ({ kind: "timeout" as const })),
      ]);

      expect(outcome).toMatchObject({ kind: "completed", reload: { ok: true } });
    } finally {
      state.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serializes every mutation in invocation order before entering AtomicConfigFile", async () => {
    let transactionCalls = 0;
    let releaseFirst = () => {};
    const firstMayEnter = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const order: string[] = [];
    const file = {
      async transaction(
        mutate: (current: Record<string, unknown>) => Promise<{
          readonly next: Record<string, unknown>;
          readonly result: unknown;
        }>,
        options: { readonly verify?: (candidate: Record<string, unknown>) => Promise<void> } = {},
      ) {
        transactionCalls++;
        if (transactionCalls === 1) await firstMayEnter;
        const result = await mutate({ providers: { seed: { kind: "api" } } });
        await options.verify?.(result.next);
        return result.result;
      },
    };
    const store = createConfigStore({
      getConfigPath: () => undefined,
      file,
      verify: async () => undefined,
    } as never);

    const first = store.mutateProviders((record) => {
      order.push("first");
      return record;
    });
    const second = store.mutateProviders((record) => {
      order.push("second");
      return record;
    });

    try {
      await Bun.sleep(0);
      expect(transactionCalls).toBe(1);
      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(["first", "second"]);
    } finally {
      releaseFirst();
      await Promise.allSettled([first, second]);
    }
  });

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

  test("preserves a staged delete marker when the config commit outcome is uncertain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-uncertain-"));
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
    let releaseDrain = (): void => {};
    const whenDrained = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const scheduled: number[] = [];
    const accountRemovals = createAccountRemovalCoordinator({
      file: committedFile,
      repository,
      onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
    });
    let verified: Readonly<Record<string, unknown>> = initial;
    const uncertainFile = {
      async transaction<T>(
        mutate: Parameters<AtomicConfigFile["transaction"]>[0],
        options: Parameters<AtomicConfigFile["transaction"]>[1] = {},
      ): Promise<T> {
        const { next } = await mutate(await committedFile.read());
        writeFileSync(configPath, JSON.stringify(next));
        await options.verify?.(next);
        throw new AtomicConfigCommitUncertainError();
      },
    } as AtomicConfigFile;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      file: uncertainFile,
      accountRemovals,
      repository,
      verify: async (candidate) => {
        verified = candidate;
        return {
          providerIds: new Set(["person"]),
          whenDrained,
          whenProviderDrained: () => whenDrained,
        };
      },
    });

    try {
      await expect(store.deleteProvider("person")).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      expect((JSON.parse(readFileSync(configPath, "utf8")) as typeof initial).providers).toEqual({});
      expect(verified["providers"]).toEqual({});
      expect(repository.readAccount("person")).not.toBeNull();
      const [marker] = repository.listPendingAccountOperations();
      expect(marker).toMatchObject({ providerId: "person", kind: "delete", targetDigest: ABSENT_PROVIDER_DIGEST });
      if (marker === undefined) throw new Error("delete marker fixture missing");
      expect(scheduled).toEqual([marker.createdAt + PENDING_OPERATION_TTL_MS]);

      releaseDrain();
      await waitUntil(() => repository.readAccount("person") === null);
      expect(repository.readAccount("person")).toBeNull();
      expect(repository.readCatalog("person")).toBeNull();
      expect(repository.readDiagnostics("person")).toEqual([]);
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      releaseDrain();
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deletes a config-only OAuth provider through verification without staging account cleanup", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-config-only-oauth-"));
    const configPath = join(dir, "config.json");
    const initial = {
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    };
    writeFileSync(configPath, JSON.stringify(initial));
    const handle = openDb({ home: dir });
    const repository = createPluginRepository(handle.sqlite);
    let stageAccountOperationCalls = 0;
    const observedRepository: PluginRepository = {
      ...repository,
      stageAccountOperation(input) {
        stageAccountOperationCalls++;
        return repository.stageAccountOperation(input);
      },
    };
    const verified: Readonly<Record<string, unknown>>[] = [];
    const store = createConfigStore({
      getConfigPath: () => configPath,
      repository: observedRepository,
      verify: async (candidate) => {
        verified.push(candidate);
        return undefined;
      },
    });

    try {
      await store.deleteProvider("person");

      expect(verified).toHaveLength(1);
      expect(verified[0]?.["providers"]).toEqual({});
      expect((JSON.parse(readFileSync(configPath, "utf8")) as typeof initial).providers).toEqual({});
      expect(stageAccountOperationCalls).toBe(0);
      expect(repository.readAccount("person")).toBeNull();
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("compensates a staged delete marker when the config write definitely fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-failed-"));
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
    const failedFile = {
      async transaction<T>(mutate: Parameters<AtomicConfigFile["transaction"]>[0]): Promise<T> {
        await mutate(await committedFile.read());
        throw new Error("write failed");
      },
    } as AtomicConfigFile;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      file: failedFile,
      repository,
      verify: async () => undefined,
    });

    try {
      await expect(store.deleteProvider("person")).rejects.toThrow("write failed");
      expect(repository.readAccount("person")).not.toBeNull();
      expect(repository.listPendingAccountOperations()).toEqual([]);
      expect(readFileSync(configPath, "utf8")).toBe(JSON.stringify(initial));
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an uncertain commit before verify only arms recovery until the old snapshot is safe", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aio-store-preverify-uncertain-"));
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
    const scheduled: number[] = [];
    const accountRemovals = createAccountRemovalCoordinator({
      file: committedFile,
      repository,
      onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
    });
    let verifications = 0;
    let reconciliations = 0;
    const uncertainFile = {
      async transaction<T>(mutate: Parameters<AtomicConfigFile["transaction"]>[0]): Promise<T> {
        const { next } = await mutate(await committedFile.read());
        writeFileSync(configPath, JSON.stringify(next));
        throw new AtomicConfigCommitUncertainError();
      },
    } as AtomicConfigFile;
    const store = createConfigStore({
      getConfigPath: () => configPath,
      file: uncertainFile,
      accountRemovals,
      onReconciliationNeeded: (operations) => {
        reconciliations++;
        expect(operations).toHaveLength(1);
        expect(operations[0]?.providerId).toBe("person");
        throw new Error("notification failure must not mask commit uncertainty");
      },
      repository,
      verify: async () => {
        verifications++;
        return undefined;
      },
    });

    try {
      await expect(store.deleteProvider("person")).rejects.toBeInstanceOf(AtomicConfigCommitUncertainError);
      await Bun.sleep(50);
      expect(verifications).toBe(0);
      expect(reconciliations).toBe(1);
      expect(repository.readAccount("person")).not.toBeNull();
      const [marker] = repository.listPendingAccountOperations();
      if (marker === undefined) throw new Error("delete marker fixture missing");
      expect(scheduled).toEqual([marker.createdAt + PENDING_OPERATION_TTL_MS]);

      await recoverPendingAccountOperations(committedFile, repository, {
        mode: "server",
        canDeleteAccount: () => true,
        now: () => marker.createdAt + PENDING_OPERATION_TTL_MS,
      });
      expect(repository.readAccount("person")).toBeNull();
      expect(repository.listPendingAccountOperations()).toEqual([]);
    } finally {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
