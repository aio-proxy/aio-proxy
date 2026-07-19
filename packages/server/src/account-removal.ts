import {
  ABSENT_PROVIDER_DIGEST,
  AccountCleanupPendingError,
  type AtomicConfigFile,
  PENDING_OPERATION_TTL_MS,
  type PendingAccountOperation,
  type PluginRepository,
} from "@aio-proxy/core";
import { OAuthPluginProviderSchema, ProviderKind } from "@aio-proxy/types";
import { minBy } from "es-toolkit/array";

import type { FifoQueue } from "./fifo-queue";
import type { RetiredProviderSnapshot } from "./runtime";

export type AccountRemovalCoordinator = {
  readonly stageRemoved: (
    previousProviders: Readonly<Record<string, unknown>>,
    nextProviders: Readonly<Record<string, unknown>>,
  ) => readonly PendingAccountOperation[];
  readonly compensate: (operations: readonly PendingAccountOperation[]) => void;
  readonly cancelReadded: (
    previousProviders: Readonly<Record<string, unknown>>,
    nextProviders: Readonly<Record<string, unknown>>,
  ) => void;
  readonly scheduleRecovery: (operations: readonly PendingAccountOperation[]) => void;
  readonly finalizeAfterDrain: (
    operations: readonly PendingAccountOperation[],
    retired: RetiredProviderSnapshot | undefined,
  ) => Promise<void>;
};

export function asProviderRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function oauthCapabilityOf(
  providerId: string,
  value: unknown,
): { readonly plugin: string; readonly capability: string } | undefined {
  const record = asProviderRecord(value);
  if (Object.hasOwn(record, "vendor")) return undefined;
  const parsed = OAuthPluginProviderSchema.safeParse({ ...record, id: providerId });
  return parsed.success ? { plugin: parsed.data.plugin, capability: parsed.data.capability } : undefined;
}

function isOAuthProviderEntry(value: unknown): boolean {
  return asProviderRecord(value)["kind"] === ProviderKind.OAuth;
}

export function createAccountRemovalCoordinator(options: {
  readonly file: AtomicConfigFile | undefined;
  readonly repository: PluginRepository | undefined;
  readonly enqueue?: FifoQueue;
  readonly canDeleteAccount?: (providerId: string) => boolean;
  readonly onRecoveryNeeded?: (nextRunAt: number) => void;
}): AccountRemovalCoordinator {
  const stageRemoved: AccountRemovalCoordinator["stageRemoved"] = (previousProviders, nextProviders) => {
    if (options.file === undefined || options.repository === undefined) return [];
    const operations: PendingAccountOperation[] = [];
    try {
      for (const [providerId, previous] of Object.entries(previousProviders)) {
        if (Object.hasOwn(nextProviders, providerId)) continue;
        if (!isOAuthProviderEntry(previous)) continue;
        const account = options.repository.readAccount(providerId);
        if (account === null) continue;
        const capability = oauthCapabilityOf(providerId, previous);
        if (
          capability !== undefined &&
          (account.plugin !== capability.plugin || account.capability !== capability.capability)
        ) {
          throw new AccountCleanupPendingError(providerId);
        }
        operations.push(
          options.repository.stageAccountOperation({
            kind: "delete",
            targetDigest: ABSENT_PROVIDER_DIGEST,
            providerId,
            expectedRuntimeRevision: account.runtimeRevision,
          }),
        );
      }
      return operations;
    } catch (error) {
      for (const operation of operations) options.repository.compensateAccountOperation(operation.operationId);
      throw error;
    }
  };

  const compensate: AccountRemovalCoordinator["compensate"] = (operations) => {
    for (const operation of operations) options.repository?.compensateAccountOperation(operation.operationId);
  };

  const cancelReadded: AccountRemovalCoordinator["cancelReadded"] = (_previousProviders, nextProviders) => {
    if (options.repository === undefined) return;
    const presentProviderIds = new Set(Object.keys(nextProviders));
    if (presentProviderIds.size === 0) return;
    for (const operation of options.repository.listPendingAccountOperations()) {
      if (operation.kind === "delete" && presentProviderIds.has(operation.providerId)) {
        options.repository.completeAccountOperation(operation.operationId);
      }
    }
  };

  async function finalizeIfStillAbsent(operation: PendingAccountOperation): Promise<void> {
    const { file, repository } = options;
    if (file === undefined || repository === undefined) return;
    await file.transaction(async (current) => {
      const pending = repository
        .listPendingAccountOperations?.()
        .some((candidate) => candidate.operationId === operation.operationId);
      if (pending === false) return { next: current, result: undefined };
      const providers = asProviderRecord(current["providers"]);
      if (Object.hasOwn(providers, operation.providerId)) {
        scheduleRecovery([operation]);
      } else if (!(options.canDeleteAccount ?? (() => true))(operation.providerId)) {
        scheduleRecovery([operation]);
      } else {
        repository.finalizeDeleteOperation(operation.operationId);
      }
      return { next: current, result: undefined };
    });
  }

  function scheduleRecovery(operations: readonly PendingAccountOperation[]): void {
    const earliest = minBy(operations, (operation) => operation.createdAt);
    if (earliest !== undefined) options.onRecoveryNeeded?.(earliest.createdAt + PENDING_OPERATION_TTL_MS);
  }

  const finalizeAfterDrain: AccountRemovalCoordinator["finalizeAfterDrain"] = (operations, retired) => {
    scheduleRecovery(operations);
    return Promise.all(
      operations.map(async (operation) => {
        await retired?.whenProviderDrained(operation.providerId);
        await (options.enqueue ?? ((fn) => fn()))(() => finalizeIfStillAbsent(operation));
      }),
    )
      .then(() => undefined)
      .catch((error: unknown) => {
        scheduleRecovery(operations);
        throw error;
      });
  };

  return { cancelReadded, compensate, finalizeAfterDrain, scheduleRecovery, stageRemoved };
}
