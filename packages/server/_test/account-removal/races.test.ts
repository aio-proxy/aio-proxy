import { ABSENT_PROVIDER_DIGEST, AtomicConfigFile, createPluginRepository } from "@aio-proxy/core";
import { openDb } from "@aio-proxy/core/db";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAccountRemovalCoordinator } from "../../src/account-removal";

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

test("a disk-side re-add before drain preserves the account and keeps its marker pending", async () => {
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
    expect(repository.listPendingAccountOperations()).toEqual(staged);
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
