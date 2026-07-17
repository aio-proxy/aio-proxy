import { expect, test } from "bun:test";
import { ABSENT_PROVIDER_DIGEST, PENDING_OPERATION_TTL_MS } from "@aio-proxy/core";
import { createAccountRemovalCoordinator } from "../../src/account-removal";

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

test("final deletion runs through the FIFO and stays pending while a snapshot still references the account", async () => {
  const events: string[] = [];
  const scheduled: number[] = [];
  const operation = {
    operationId: "delete:person",
    providerId: "person",
    kind: "delete" as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 789,
  };
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction: async (fn: (current: Record<string, unknown>) => Promise<unknown>) => {
        events.push("config-lock");
        return fn({ providers: {} });
      },
    },
    repository: {
      finalizeDeleteOperation() {
        events.push("deleted");
        return "deleted";
      },
    },
    enqueue: async (fn: () => Promise<unknown>) => {
      events.push("fifo");
      return fn();
    },
    canDeleteAccount: () => false,
    onRecoveryNeeded: (nextRunAt: number) => scheduled.push(nextRunAt),
  } as never);

  await coordinator.finalizeAfterDrain([operation], undefined);

  expect(events).toEqual(["fifo", "config-lock"]);
  expect(scheduled).toEqual([789 + PENDING_OPERATION_TTL_MS, 789 + PENDING_OPERATION_TTL_MS]);
});

test("final deletion stays pending when the provider is present on disk", async () => {
  const events: string[] = [];
  const scheduled: number[] = [];
  const operation = {
    operationId: "delete:person",
    providerId: "person",
    kind: "delete" as const,
    targetDigest: ABSENT_PROVIDER_DIGEST,
    appliedRevision: 1,
    createdAt: 987,
  };
  const coordinator = createAccountRemovalCoordinator({
    file: {
      transaction: async (fn: (current: Record<string, unknown>) => Promise<unknown>) =>
        fn({ providers: { person: { kind: "oauth" } } }),
    },
    repository: {
      listPendingAccountOperations: () => [operation],
      completeAccountOperation() {
        events.push("completed");
      },
      finalizeDeleteOperation() {
        events.push("deleted");
        return "deleted";
      },
    },
    onRecoveryNeeded: (nextRunAt: number) => scheduled.push(nextRunAt),
  } as never);

  await coordinator.finalizeAfterDrain([operation], undefined);

  expect(events).toEqual([]);
  expect(scheduled).toEqual([987 + PENDING_OPERATION_TTL_MS, 987 + PENDING_OPERATION_TTL_MS]);
});
