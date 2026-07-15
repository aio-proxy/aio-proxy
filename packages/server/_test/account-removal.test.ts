import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABSENT_PROVIDER_DIGEST,
  AccountCleanupPendingError,
  AtomicConfigFile,
  createPluginRepository,
  PENDING_OPERATION_TTL_MS,
} from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { createAccountRemovalCoordinator } from "../src/account-removal";

test("compensates earlier delete markers when staging a later removal fails", () => {
  const compensated: string[] = [];
  const repository = {
    readAccount(providerId: string) {
      return { providerId, plugin: "@example/oauth", capability: "default", runtimeRevision: 1 };
    },
    stageAccountOperation(input: { readonly providerId: string }) {
      if (input.providerId === "second") throw new Error("stage failed");
      return {
        operationId: `delete:${input.providerId}`,
        providerId: input.providerId,
        targetDigest: ABSENT_PROVIDER_DIGEST,
      };
    },
    compensateAccountOperation(operationId: string) {
      compensated.push(operationId);
    },
  };
  const coordinator = createAccountRemovalCoordinator({ file: {} as never, repository: repository as never });

  expect(() =>
    coordinator.stageRemoved(
      {
        first: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
        second: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
      {},
    ),
  ).toThrow("stage failed");
  expect(compensated).toEqual(["delete:first"]);
});

test.each([
  ["invalid", { kind: "oauth", plugin: "@example/oauth", capability: "" }],
  ["legacy", { kind: "oauth", vendor: "legacy-provider" }],
])("stages a runtime-revision CAS marker for a removed %s OAuth row", (_label, previous) => {
  const staged: unknown[] = [];
  const repository = {
    readAccount(providerId: string) {
      return { providerId, plugin: "@example/other", capability: "default", runtimeRevision: 7 };
    },
    stageAccountOperation(input: unknown) {
      staged.push(input);
      return {
        operationId: "delete:person",
        providerId: "person",
        targetDigest: ABSENT_PROVIDER_DIGEST,
      };
    },
  };
  const coordinator = createAccountRemovalCoordinator({ file: {} as never, repository: repository as never });

  expect(coordinator.stageRemoved({ person: previous }, {})).toHaveLength(1);
  expect(staged).toEqual([
    {
      kind: "delete",
      targetDigest: ABSENT_PROVIDER_DIGEST,
      providerId: "person",
      expectedRuntimeRevision: 7,
    },
  ]);
});

test("rejects staging a removed structured OAuth row whose account capability does not match", () => {
  let staged = 0;
  const repository = {
    readAccount() {
      return {
        providerId: "person",
        plugin: "@example/other",
        capability: "alternate",
        runtimeRevision: 7,
      };
    },
    stageAccountOperation() {
      staged++;
      throw new Error("must not stage");
    },
  };
  const coordinator = createAccountRemovalCoordinator({ file: {} as never, repository: repository as never });

  expect(() =>
    coordinator.stageRemoved({ person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } }, {}),
  ).toThrow(AccountCleanupPendingError);
  expect(staged).toBe(0);
});

test("does not stage a marker when a removed structured OAuth row has no stored account", () => {
  let staged = 0;
  const coordinator = createAccountRemovalCoordinator({
    file: {} as never,
    repository: {
      readAccount: () => null,
      stageAccountOperation() {
        staged++;
        throw new Error("must not stage");
      },
    } as never,
  });

  expect(
    coordinator.stageRemoved({ person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } }, {}),
  ).toEqual([]);
  expect(staged).toBe(0);
});

test("never stages a stale account for a removed API or AI SDK row", () => {
  let staged = 0;
  const repository = {
    readAccount(providerId: string) {
      return { providerId, plugin: "@example/oauth", capability: "default", runtimeRevision: 1 };
    },
    stageAccountOperation() {
      staged++;
      throw new Error("must not stage");
    },
  };
  const coordinator = createAccountRemovalCoordinator({ file: {} as never, repository: repository as never });

  expect(
    coordinator.stageRemoved(
      {
        api: { kind: "api", protocol: "openai-compatible", baseURL: "https://api.example.test" },
        ai: { kind: "ai-sdk", packageName: "@ai-sdk/openai-compatible" },
      },
      {},
    ),
  ).toEqual([]);
  expect(staged).toBe(0);
});

test("a committed delete marker schedules recovery before its retired snapshot drains", async () => {
  let releaseDrain = (): void => {};
  const whenDrained = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });
  const scheduled: number[] = [];
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction: async (fn: (current: Record<string, unknown>) => Promise<unknown>) => fn({ providers: {} }),
    } as never,
    repository: {
      finalizeDeleteOperation() {
        return "deleted";
      },
    } as never,
    onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
  });
  const operation = {
    operationId: "delete:person",
    providerId: "person",
    kind: "delete" as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 123,
  };

  const finalizing = coordinator.finalizeAfterDrain([operation], {
    providerIds: new Set(["person"]),
    whenDrained,
    whenProviderDrained: () => whenDrained,
  });
  expect(scheduled).toEqual([123 + PENDING_OPERATION_TTL_MS]);
  releaseDrain();
  await finalizing;
});

test("a failed delete finalizer re-arms recovery at the marker deadline", async () => {
  const scheduled: number[] = [];
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction() {
        throw new Error("transient finalize failure");
      },
    } as never,
    repository: {} as never,
    onRecoveryNeeded: (nextRunAt) => scheduled.push(nextRunAt),
  });
  const operation = {
    operationId: "delete:person",
    providerId: "person",
    kind: "delete" as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 456,
  };

  await expect(coordinator.finalizeAfterDrain([operation], undefined)).rejects.toThrow("transient finalize failure");
  expect(scheduled).toEqual([456 + PENDING_OPERATION_TTL_MS, 456 + PENDING_OPERATION_TTL_MS]);
});

test("coordinates absent digest, snapshot drainage, and final config recheck", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-account-removal-"));
  const configPath = join(home, "config.json");
  writeFileSync(configPath, JSON.stringify({ providers: { person: { kind: "oauth" } } }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const create = repository.stageAccountOperation({
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
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(create.operationId);
  const file = new AtomicConfigFile(configPath);
  const coordinator = createAccountRemovalCoordinator({ file, repository });
  const staged = coordinator.stageRemoved(
    { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    {},
  );
  let releaseDrain = (): void => {};
  const whenDrained = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });

  try {
    expect(staged).toHaveLength(1);
    expect(staged[0]?.targetDigest).toBe(ABSENT_PROVIDER_DIGEST);
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    const finalized = coordinator.finalizeAfterDrain(staged, {
      providerIds: new Set(["person"]),
      whenDrained,
      whenProviderDrained: () => whenDrained,
    });

    await Promise.resolve();
    expect(repository.readAccount("person")).not.toBeNull();
    releaseDrain();
    await finalized;
    expect(repository.readAccount("person")).toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    handle.close();
    rmSync(home, { force: true, recursive: true });
  }
});

test("re-adding an invalid OAuth row before drain preserves the account and completes its marker", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-account-removal-"));
  const configPath = join(home, "config.json");
  const invalid = { kind: "oauth", plugin: "@example/oauth", capability: "" };
  writeFileSync(configPath, JSON.stringify({ providers: { person: invalid } }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const create = repository.stageAccountOperation({
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
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(create.operationId);
  const coordinator = createAccountRemovalCoordinator({ file: new AtomicConfigFile(configPath), repository });
  const staged = coordinator.stageRemoved({ person: invalid }, {});
  let releaseDrain = (): void => {};
  const whenDrained = new Promise<void>((resolve) => {
    releaseDrain = resolve;
  });

  try {
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    const finalizing = coordinator.finalizeAfterDrain(staged, {
      providerIds: new Set(["person"]),
      whenDrained,
      whenProviderDrained: () => whenDrained,
    });
    writeFileSync(configPath, JSON.stringify({ providers: { person: invalid } }));
    releaseDrain();
    await finalizing;
    expect(repository.readAccount("person")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    handle.close();
    rmSync(home, { force: true, recursive: true });
  }
});

test("a live delete marker cannot remove an account with a superseding runtime revision", async () => {
  const home = mkdtempSync(join(tmpdir(), "aio-proxy-account-removal-"));
  const configPath = join(home, "config.json");
  const invalid = { kind: "oauth", plugin: "@example/oauth", capability: "" };
  writeFileSync(configPath, JSON.stringify({ providers: { person: invalid } }));
  const handle = openDb({ home });
  const repository = createPluginRepository(handle.sqlite);
  const create = repository.stageAccountOperation({
    kind: "create",
    targetDigest: "create",
    account: {
      providerId: "person",
      plugin: "@example/oauth",
      capability: "default",
      fingerprint: "person@example.com",
      options: {},
      secrets: {},
      credential: { token: "old" },
      catalog: {
        kind: "replace",
        value: {
          catalog: { language: [], image: [], embedding: [], speech: [], transcription: [], reranking: [] },
          refreshedAt: 1,
        },
      },
    },
  });
  repository.completeAccountOperation(create.operationId);
  const coordinator = createAccountRemovalCoordinator({ file: new AtomicConfigFile(configPath), repository });
  const [stale] = coordinator.stageRemoved({ person: invalid }, {});
  if (stale === undefined) throw new Error("delete marker fixture missing");
  handle.sqlite
    .query("UPDATE oauth_account SET runtime_revision = 2, credential_json = ? WHERE provider_id = ?")
    .run(JSON.stringify({ token: "new" }), "person");

  try {
    expect(repository.listPendingAccountOperations()).toEqual([stale]);
    writeFileSync(configPath, JSON.stringify({ providers: {} }));
    await coordinator.finalizeAfterDrain([stale], undefined);
    expect(repository.readAccount("person")).toMatchObject({ runtimeRevision: 2, credential: { token: "new" } });
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    handle.close();
    rmSync(home, { force: true, recursive: true });
  }
});
