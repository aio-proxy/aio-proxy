import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRepository, ORPHAN_ACCOUNT_GRACE_MS, PENDING_OPERATION_TTL_MS } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createServerState } from "../../src/server-state";
import { cleanup, createManualRecoveryScheduler, deferred, seedOAuthAccount, waitUntil } from "./test-support";

afterEach(cleanup);

test("a committed delete marker arms the server recovery timer", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-marker-timer-"));
  const configPath = join(home, "config.json");
  const input = {
    providers: {
      person: { kind: "oauth", plugin: "@example/oauth", capability: "" },
    },
  };
  writeFileSync(configPath, JSON.stringify(input));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const recoveryScheduler = createManualRecoveryScheduler(Date.now());
  let recoveries = 0;
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    __test: {
      recoveryScheduler: recoveryScheduler.hooks,
      async recoverPendingAccountOperations() {
        recoveries++;
        return {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    await state.configStore.deleteProvider("person");
    const pending = repository.listPendingAccountOperations()[0];
    if (pending === undefined) throw new Error("delete marker missing");
    await waitUntil(() => recoveryScheduler.nextRunAt() === pending.createdAt + PENDING_OPERATION_TTL_MS);
    recoveryScheduler.advanceTo(pending.createdAt + PENDING_OPERATION_TTL_MS);
    await waitUntil(() => recoveries === 3);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("server recovery schedules the earliest competing orphan and pending deadlines and close clears the later one", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-earliest-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const orphanCreate = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "orphan-create",
    account: {
      providerId: "orphan",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "orphan@example.com",
      options: {},
      secrets: {},
      credential: { token: "orphan" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  repository.completeAccountOperation(orphanCreate.operationId);
  const orphan = repository.readAccount("orphan");
  if (orphan === null) throw new Error("orphan fixture missing");
  await waitUntil(() => Date.now() > orphan.updatedAt);
  const pending = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "pending-create",
    account: {
      providerId: "pending",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "pending@example.com",
      options: {},
      secrets: {},
      credential: { token: "pending" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: Date.now(),
        },
      },
    },
  });
  const orphanDeadline = orphan.updatedAt + ORPHAN_ACCOUNT_GRACE_MS;
  const pendingDeadline = pending.createdAt + PENDING_OPERATION_TTL_MS;
  const recoveryScheduler = createManualRecoveryScheduler(pending.createdAt);
  const orphanDeleted = deferred();
  const observedRepository = {
    ...repository,
    deleteAccount(providerId: string) {
      repository.deleteAccount(providerId);
      if (providerId === "orphan") orphanDeleted.resolve();
    },
  };
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: observedRepository,
    __test: { recoveryScheduler: recoveryScheduler.hooks },
  });

  try {
    expect(ORPHAN_ACCOUNT_GRACE_MS).toBe(PENDING_OPERATION_TTL_MS);
    expect(orphanDeadline).toBeLessThan(pendingDeadline);
    expect(recoveryScheduler.nextRunAt()).toBe(orphanDeadline);
    recoveryScheduler.advanceTo(orphanDeadline - 1);
    expect(repository.readAccount("orphan")).not.toBeNull();
    expect(repository.readAccount("pending")).not.toBeNull();

    recoveryScheduler.advanceTo(orphanDeadline);
    await orphanDeleted.promise;
    expect(repository.readAccount("orphan")).toBeNull();
    expect(repository.readAccount("pending")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toHaveLength(1);
    await waitUntil(() => recoveryScheduler.nextRunAt() === pendingDeadline);

    state.close();
    expect(recoveryScheduler.nextRunAt()).toBeUndefined();
    expect(repository.readAccount("pending")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toHaveLength(1);
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
