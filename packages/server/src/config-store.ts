import {
  AccountCleanupPendingError,
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  type PendingAccountOperation,
  type PluginRepository,
} from "@aio-proxy/core";
import {
  type AccountRemovalCoordinator,
  asProviderRecord,
  createAccountRemovalCoordinator,
  oauthCapabilityOf,
} from "./account-removal";
import type { FifoQueue } from "./fifo-queue";
import { createFifoQueue } from "./fifo-queue";
import type { RetiredProviderSnapshot } from "./runtime";

export class ConfigPathMissingError extends Error {
  constructor() {
    super("config file path is not configured");
    this.name = "ConfigPathMissingError";
  }
}

export class ConfigReloadRejectedError extends Error {
  constructor(reason: string) {
    super(`config reload rejected: ${reason}`);
    this.name = "ConfigReloadRejectedError";
  }
}

export type ConfigStoreOptions = {
  readonly getConfigPath: () => string | undefined;
  readonly file?: AtomicConfigFile;
  readonly verify: (candidate: Readonly<Record<string, unknown>>) => Promise<RetiredProviderSnapshot | undefined>;
  readonly repository?: PluginRepository;
  readonly accountRemovals?: AccountRemovalCoordinator;
  readonly enqueue?: FifoQueue;
  readonly onReconciliationNeeded?: (operations: readonly PendingAccountOperation[]) => void;
};

export type ConfigStore = {
  readonly file: AtomicConfigFile | undefined;
  readonly deleteProvider: (providerId: string) => Promise<void>;
  readonly mutateProviders: (fn: (record: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
};

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const path = options.getConfigPath();
  const file = options.file ?? (path === undefined ? undefined : new AtomicConfigFile(path));
  const accountRemovals =
    options.accountRemovals ?? createAccountRemovalCoordinator({ file, repository: options.repository });
  const enqueue = options.enqueue ?? createFifoQueue();

  async function verifyCandidate(
    candidate: Readonly<Record<string, unknown>>,
  ): Promise<RetiredProviderSnapshot | undefined> {
    try {
      return await options.verify(candidate);
    } catch (error) {
      throw new ConfigReloadRejectedError(error instanceof Error ? error.message : String(error));
    }
  }

  async function mutateProvidersNow(fn: (record: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
    if (file === undefined) throw new ConfigPathMissingError();
    const staged: PendingAccountOperation[] = [];
    let retired: RetiredProviderSnapshot | undefined;
    let verificationCompleted = false;
    try {
      await file.transaction(
        async (current) => {
          const providers = asProviderRecord(current["providers"]);
          const nextProviders = fn(providers);
          staged.push(...accountRemovals.stageRemoved(providers, nextProviders));
          return { next: { ...current, providers: nextProviders }, result: undefined };
        },
        {
          verify: async (candidate) => {
            retired = await verifyCandidate(candidate);
            verificationCompleted = true;
          },
        },
      );
    } catch (error) {
      if (error instanceof AtomicConfigCommitUncertainError) {
        if (verificationCompleted) {
          void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
        } else {
          accountRemovals.scheduleRecovery(staged);
          try {
            options.onReconciliationNeeded?.(staged);
          } catch {}
        }
      } else {
        accountRemovals.compensate(staged);
      }
      throw error;
    }

    void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
  }

  async function deleteProviderNow(providerId: string): Promise<void> {
    await mutateProvidersNow((providers) => {
      const capability = oauthCapabilityOf(providerId, providers[providerId]);
      if (capability !== undefined && options.repository !== undefined) {
        const account = options.repository.readAccount(providerId);
        if (
          account !== null &&
          (account.plugin !== capability.plugin || account.capability !== capability.capability)
        ) {
          throw new AccountCleanupPendingError(providerId);
        }
      }
      const { [providerId]: _removed, ...remaining } = providers;
      return remaining;
    });
  }

  return {
    deleteProvider: (providerId) => enqueue(() => deleteProviderNow(providerId)),
    file,
    mutateProviders: (fn) => enqueue(() => mutateProvidersNow(fn)),
  };
}
