import { afterEach, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginRepository,
  PENDING_OPERATION_TTL_MS,
  RECOVERY_DRAIN_RETRY_MS,
  recoverPendingAccountOperations,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createServerState } from "../../src/server-state";
import { cleanup, createManualRecoveryScheduler, deferred, flushMicrotasks, seedOAuthAccount } from "./test-support";

afterEach(cleanup);

test("startup recovery retains a delete marker while the disk provider has not committed to the Router", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-startup-delete-recovery-"));
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: {
        person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
    }),
  );
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const account = repository.readAccount("person");
  if (account === null) throw new Error("account fixture missing");
  const pending = repository.stageAccountOperation({
    kind: "delete",
    targetDigest: "absent",
    providerId: "person",
    expectedRuntimeRevision: account.runtimeRevision,
  });
  handle.sqlite
    .query("UPDATE oauth_pending_operation SET created_at = 0 WHERE operation_id = ?")
    .run(pending.operationId);
  const now = PENDING_OPERATION_TTL_MS + 1;
  const recoveryScheduler = createManualRecoveryScheduler(now);
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    __test: { recoveryScheduler: recoveryScheduler.hooks },
  } as never);

  try {
    expect(repository.readAccount("person")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toHaveLength(1);
    expect(recoveryScheduler.nextRunAt()).toBe(now + RECOVERY_DRAIN_RETRY_MS);
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).not.toContain("person");
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a rejected recovery run is logged with a fixed payload and retried", async () => {
  jest.useFakeTimers();
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-rejection-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  let recoveries = 0;
  const logs: unknown[] = [];
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginLogger: (entry) => logs.push(entry),
    __test: {
      async recoverPendingAccountOperations() {
        recoveries++;
        if (recoveries === 1) return {};
        if (recoveries === 2) return { nextRunAt: Date.now() + 100 };
        if (recoveries === 3) throw new Error("transient recovery failure");
        return {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    jest.advanceTimersByTime(100);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    expect(logs).toEqual([
      {
        event: "plugin.account.recovery.failed",
        code: "ACCOUNT_RECOVERY_FAILED",
        context: {},
        error: { name: "Error", message: "Pending account recovery failed" },
      },
    ]);

    jest.advanceTimersByTime(RECOVERY_DRAIN_RETRY_MS - 1);
    await flushMicrotasks();
    expect(recoveries).toBe(3);
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(recoveries).toBe(4);
  } finally {
    state.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed delete finalizer is retried by the marker recovery deadline", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-recovery-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  let finalizeAttempts = 0;
  let recoveries = 0;
  const recoveryFinished = deferred();
  const observedRepository = {
    ...repository,
    finalizeDeleteOperation(operationId: string) {
      finalizeAttempts++;
      if (finalizeAttempts === 1) throw new Error("transient finalize failure");
      return repository.finalizeDeleteOperation(operationId);
    },
  };
  const account = repository.readAccount("person");
  if (account === null) throw new Error("account fixture missing");
  const pending = observedRepository.stageAccountOperation({
    kind: "delete",
    targetDigest: "absent",
    providerId: "person",
    expectedRuntimeRevision: account.runtimeRevision,
  });
  const recoveryScheduler = createManualRecoveryScheduler(pending.createdAt);
  expect(() => observedRepository.finalizeDeleteOperation(pending.operationId)).toThrow("transient finalize failure");
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: observedRepository,
    __test: {
      recoveryScheduler: recoveryScheduler.hooks,
      async recoverPendingAccountOperations(...args: Parameters<typeof recoverPendingAccountOperations>) {
        recoveries++;
        const result = await recoverPendingAccountOperations(...args);
        if (recoveries === 3) recoveryFinished.resolve();
        return result;
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    expect(finalizeAttempts).toBe(1);
    expect(repository.listPendingAccountOperations()).toHaveLength(1);
    expect(recoveryScheduler.nextRunAt()).toBe(pending.createdAt + PENDING_OPERATION_TTL_MS);

    recoveryScheduler.advanceTo(pending.createdAt + PENDING_OPERATION_TTL_MS);
    await recoveryFinished.promise;
    expect(recoveries).toBe(3);
    expect(finalizeAttempts).toBe(2);
    expect(repository.readAccount("person")).toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
