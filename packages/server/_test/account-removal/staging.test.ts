import { expect, test } from "bun:test";
import { ABSENT_PROVIDER_DIGEST, AccountCleanupPendingError } from "@aio-proxy/core";
import { createAccountRemovalCoordinator } from "../../src/account-removal";

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
