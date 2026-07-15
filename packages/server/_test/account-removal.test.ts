import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABSENT_PROVIDER_DIGEST, AtomicConfigFile, createPluginRepository } from "@aio-proxy/core";
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

test("never stages a stale account for a removed non-OAuth or mismatched provider", () => {
  let staged = 0;
  const repository = {
    readAccount(providerId: string) {
      return { providerId, plugin: "@example/other", capability: "default", runtimeRevision: 1 };
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
        oauth: { kind: "oauth", plugin: "@example/oauth", capability: "default" },
      },
      {},
    ),
  ).toEqual([]);
  expect(staged).toBe(0);
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

test("keeps a re-added account when the retired snapshot drains", async () => {
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
  const coordinator = createAccountRemovalCoordinator({ file: new AtomicConfigFile(configPath), repository });
  const staged = coordinator.stageRemoved(
    { person: { kind: "oauth", plugin: "@example/oauth", capability: "default" } },
    {},
  );

  try {
    await coordinator.finalizeAfterDrain(staged, undefined);
    expect(repository.readAccount("person")).not.toBeNull();
    expect(repository.listPendingAccountOperations()).toEqual([]);
  } finally {
    handle.close();
    rmSync(home, { force: true, recursive: true });
  }
});
