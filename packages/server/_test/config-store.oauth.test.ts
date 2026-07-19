import {
  ABSENT_PROVIDER_DIGEST,
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  createPluginRepository,
  PENDING_OPERATION_TTL_MS,
  type PluginRepository,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAccountRemovalCoordinator } from "../src/account-removal";
import { createConfigStore } from "../src/config-store";
import { seedOAuthAccount, waitUntil } from "./config-store.oauth.test-support";

describe("createConfigStore OAuth cleanup", () => {
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
      expect(verified.providers).toEqual({});
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
      expect(verified[0]?.providers).toEqual({});
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
});
