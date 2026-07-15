import {
  ABSENT_PROVIDER_DIGEST,
  type AtomicConfigFile,
  type PendingAccountOperation,
  type PluginRepository,
} from "@aio-proxy/core";
import { OAuthPluginProviderSchema } from "@aio-proxy/types";
import type { RetiredProviderSnapshot } from "./runtime";

export type AccountRemovalCoordinator = {
  readonly stageRemoved: (
    previousProviders: Readonly<Record<string, unknown>>,
    nextProviders: Readonly<Record<string, unknown>>,
  ) => readonly PendingAccountOperation[];
  readonly compensate: (operations: readonly PendingAccountOperation[]) => void;
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
  const parsed = OAuthPluginProviderSchema.safeParse({ ...asProviderRecord(value), id: providerId });
  return parsed.success ? { plugin: parsed.data.plugin, capability: parsed.data.capability } : undefined;
}

export function createAccountRemovalCoordinator(options: {
  readonly file: AtomicConfigFile | undefined;
  readonly repository: PluginRepository | undefined;
}): AccountRemovalCoordinator {
  const stageRemoved: AccountRemovalCoordinator["stageRemoved"] = (previousProviders, nextProviders) => {
    if (options.file === undefined || options.repository === undefined) return [];
    const operations: PendingAccountOperation[] = [];
    try {
      for (const [providerId, previous] of Object.entries(previousProviders)) {
        if (Object.hasOwn(nextProviders, providerId)) continue;
        const capability = oauthCapabilityOf(providerId, previous);
        if (capability === undefined) continue;
        const account = options.repository.readAccount(providerId);
        if (account === null || account.plugin !== capability.plugin || account.capability !== capability.capability) {
          continue;
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

  async function finalizeIfStillAbsent(operation: PendingAccountOperation): Promise<void> {
    if (options.file === undefined || options.repository === undefined) return;
    await options.file.transaction(async (current) => {
      const providers = asProviderRecord(current["providers"]);
      if (Object.hasOwn(providers, operation.providerId)) {
        options.repository?.completeAccountOperation(operation.operationId);
      } else {
        options.repository?.finalizeDeleteOperation(operation.operationId);
      }
      return { next: current, result: undefined };
    });
  }

  const finalizeAfterDrain: AccountRemovalCoordinator["finalizeAfterDrain"] = (operations, retired) => {
    return Promise.all(
      operations.map(async (operation) => {
        await retired?.whenProviderDrained(operation.providerId);
        await finalizeIfStillAbsent(operation);
      }),
    ).then(() => undefined);
  };

  return { compensate, finalizeAfterDrain, stageRemoved };
}
