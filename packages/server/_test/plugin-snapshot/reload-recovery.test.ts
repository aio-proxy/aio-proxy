import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomicConfigFile,
  createPluginRepository,
  PENDING_OPERATION_TTL_MS,
  RECOVERY_DRAIN_RETRY_MS,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createServerState } from "../../src/server-state";
import {
  cleanup,
  createManualRecoveryScheduler,
  deferred,
  flushMicrotasks,
  routedOAuthDescriptor,
  seedOAuthAccount,
  waitUntil,
} from "./test-support";

afterEach(cleanup);

test("scheduled recovery waits behind an in-flight config mutation in the server FIFO", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-fifo-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const runtimeStarted = deferred();
  const releaseRuntime = deferred();
  const recoveryScheduler = createManualRecoveryScheduler(Date.now());
  let recoveries = 0;
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [
      {
        packageName: "@example/oauth",
        version: "1.0.0",
        descriptor: routedOAuthDescriptor(async () => {
          runtimeStarted.resolve();
          await releaseRuntime.promise;
        }),
      },
    ],
    __test: {
      recoveryScheduler: recoveryScheduler.hooks,
      async recoverPendingAccountOperations() {
        recoveries++;
        return recoveries === 2 ? { nextRunAt: recoveryScheduler.hooks.now() + 1 } : {};
      },
    },
  } as never);

  try {
    expect(recoveries).toBe(2);
    const mutation = state.configStore.mutateProviders((providers) => ({
      ...providers,
      person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
    }));
    await runtimeStarted.promise;

    const recoveryRunAt = recoveryScheduler.nextRunAt();
    if (recoveryRunAt === undefined) throw new Error("recovery timer missing");
    recoveryScheduler.advanceTo(recoveryRunAt);
    await flushMicrotasks();
    expect(recoveries).toBe(2);

    releaseRuntime.resolve();
    await mutation;
    await waitUntil(() => recoveries === 3);
  } finally {
    releaseRuntime.resolve();
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("scheduled recovery retains a delete marker when disk re-add has not committed to the Router", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-scheduled-delete-recovery-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
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
  const recoveryScheduler = createManualRecoveryScheduler(pending.createdAt);
  const state = await createServerState({
    config: ConfigSchema.parse({ providers: {} }),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    __test: { recoveryScheduler: recoveryScheduler.hooks },
  } as never);

  try {
    const deadline = pending.createdAt + PENDING_OPERATION_TTL_MS;
    expect(recoveryScheduler.nextRunAt()).toBe(deadline);
    writeFileSync(
      configPath,
      JSON.stringify({
        providers: {
          person: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
        },
      }),
    );

    recoveryScheduler.advanceTo(deadline);
    await waitUntil(() => recoveryScheduler.nextRunAt() === deadline + RECOVERY_DRAIN_RETRY_MS);

    expect(repository.readAccount("person")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([pending]);
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).not.toContain("person");
  } finally {
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test("a failed re-add commit does not cancel the prior delete marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-readd-rollback-"));
  const configPath = join(home, "config.json");
  const provider = { kind: "oauth", plugin: "@example/oauth", capability: "default" };
  const input = { providers: { person: provider } };
  writeFileSync(configPath, JSON.stringify(input));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  let catalogJobReplacements = 0;
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor: routedOAuthDescriptor() }],
    __test: {
      onCatalogJobsReplaced() {
        catalogJobReplacements++;
        if (catalogJobReplacements === 3) throw new Error("catalog job replacement failed");
      },
    },
  } as never);
  const lease = state.acquireProviderSnapshot();

  try {
    await state.configStore.deleteProvider("person");
    const marker = repository.listPendingAccountOperations()[0];
    if (marker === undefined) throw new Error("delete marker missing");

    await expect(
      state.configStore.mutateProviders((providers) => ({ ...providers, person: provider })),
    ).rejects.toThrow("catalog job replacement failed");

    expect((await new AtomicConfigFile(configPath).read()).providers).toEqual({});
    expect(repository.listPendingAccountOperations()).toEqual([marker]);
    expect(repository.readAccount("person")).not.toBeNull();
  } finally {
    lease.release();
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
