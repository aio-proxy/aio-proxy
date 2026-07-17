import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AtomicConfigFile, createPluginRepository, recoverPendingAccountOperations } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { ConfigSchema } from "@aio-proxy/types";
import { createAccountRemovalCoordinator } from "../../src/account-removal";
import { createDashboardRoutes } from "../../src/dashboard-routes/config";
import { createSnapshotManager } from "../../src/plugin-snapshot";
import { createServerState } from "../../src/server-state";
import { cleanup, flushMicrotasks, routedOAuthDescriptor, seedOAuthAccount, snapshot, waitUntil } from "./test-support";

afterEach(cleanup);

test("OAuth deletion cascades account data only after the retired snapshot drains", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-drain-"));
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    }),
  );
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  repository.writeDiagnostic("person", {
    code: "CREDENTIAL_REFRESH_FAILED",
    summary: "refresh failed",
    retryable: true,
    occurredAt: new Date(0).toISOString(),
  });
  const file = new AtomicConfigFile(configPath);
  const removals = createAccountRemovalCoordinator({ file, repository });
  let operations: ReturnType<typeof removals.stageRemoved> = [];
  await file.transaction(async (current) => {
    const providers = current.providers as Record<string, unknown>;
    operations = removals.stageRemoved(providers, {});
    return { next: { ...current, providers: {} }, result: undefined };
  });
  const manager = createSnapshotManager(snapshot("person"));
  const lease = manager.acquire();
  const retired = manager.swap({ ...snapshot("empty"), providers: [] });
  const finalized = removals.finalizeAfterDrain(operations, retired);

  await Bun.sleep(0);
  expect(repository.readAccount("person")).not.toBeNull();
  lease.release();
  await finalized;
  expect(repository.readAccount("person")).toBeNull();
  expect(repository.readCatalog("person")).toBeNull();
  expect(repository.readDiagnostics("person")).toEqual([]);
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

test("OAuth deletion waits for every older retired snapshot containing the provider", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-all-retired-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: {} }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const file = new AtomicConfigFile(configPath);
  const removals = createAccountRemovalCoordinator({ file, repository });
  const operations = removals.stageRemoved(
    { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    {},
  );
  const manager = createSnapshotManager(snapshot("person"));
  const oldestLease = manager.acquire();
  manager.swap({ ...snapshot("unavailable"), providers: [] });
  const deletionRetired = manager.swap({ ...snapshot("empty"), providers: [] });
  const finalized = removals.finalizeAfterDrain(operations, deletionRetired);

  const finalizedBeforeOldestDrain = await Promise.race([finalized.then(() => true), Bun.sleep(120).then(() => false)]);
  oldestLease.release();
  await finalized;
  expect(finalizedBeforeOldestDrain).toBe(false);
  expect(repository.readAccount("person")).toBeNull();
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

test("pending deletion recovery is gated by current and undrained retired snapshots", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-recovery-gate-"));
  const configPath = join(home, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      providers: { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    }),
  );
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const file = new AtomicConfigFile(configPath);
  const removals = createAccountRemovalCoordinator({ file, repository });
  await file.transaction(async (current) => {
    const providers = current.providers as Record<string, unknown>;
    removals.stageRemoved(providers, {});
    return { next: { ...current, providers: {} }, result: undefined };
  });
  const manager = createSnapshotManager(snapshot("person"));
  const lease = manager.acquire();
  const retired = manager.swap({ ...snapshot("empty"), providers: [] });
  const later = Date.now() + 60 * 60_000;

  const gated = await recoverPendingAccountOperations(file, repository, {
    mode: "server",
    now: () => later,
    canDeleteAccount: manager.canDeleteAccount,
  });
  expect(repository.readAccount("person")).not.toBeNull();
  expect(gated.nextRunAt).toBeDefined();

  lease.release();
  await retired.whenDrained;
  await recoverPendingAccountOperations(file, repository, {
    mode: "server",
    now: () => later,
    canDeleteAccount: manager.canDeleteAccount,
  });
  expect(repository.readAccount("person")).toBeNull();
  handle.close();
  rmSync(home, { recursive: true, force: true });
});

test("delete, re-add, and delete again only removes the account after every routed incarnation drains", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-delete-readd-delete-"));
  const configPath = join(home, "config.json");
  const provider = { kind: "oauth", plugin: "@example/oauth", capability: "default" };
  const input = { providers: { person: provider } };
  writeFileSync(configPath, JSON.stringify(input));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  seedOAuthAccount(repository);
  const descriptor = routedOAuthDescriptor();
  const state = await createServerState({
    config: ConfigSchema.parse(input),
    configPath,
    watchConfig: false,
    dbHome: home,
    pluginRepository: repository,
    builtIns: [{ packageName: "@example/oauth", version: "1.0.0", descriptor }],
  });
  const oldestLease = state.acquireProviderSnapshot();
  const routes = createDashboardRoutes(state);

  try {
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).toContain("person");
    const firstDelete = await routes.request("/providers/person", { method: "DELETE" });
    expect(firstDelete.status).toBe(200);
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).not.toContain("person");
    const first = repository.listPendingAccountOperations()[0];
    if (first === undefined) throw new Error("first delete marker missing");

    await state.configStore.mutateProviders((providers) => ({ ...providers, person: provider }));
    expect(repository.readAccount("person")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).toContain("person");
    const readdedLease = state.acquireProviderSnapshot();

    const secondDelete = await routes.request("/providers/person", { method: "DELETE" });
    expect(secondDelete.status).toBe(200);
    expect(state.currentProviderSnapshot().providers.map(({ id }) => id)).not.toContain("person");
    const second = repository.listPendingAccountOperations()[0];
    if (second === undefined) throw new Error("second delete marker missing");
    expect(second.operationId).not.toBe(first.operationId);

    readdedLease.release();
    await flushMicrotasks();
    expect(repository.finalizeDeleteOperation(first.operationId)).toBe("superseded");
    expect(repository.readAccount("person")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([second]);

    oldestLease.release();
    await waitUntil(() => repository.readAccount("person") === null);
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    oldestLease.release();
    state.close();
    handle.close();
    rmSync(home, { recursive: true, force: true });
  }
});
