import {
  AccountCleanupPendingError,
  AtomicConfigFile,
  deleteOAuthAccount,
  type PendingAccountOperation,
  type PluginRepository,
} from "@aio-proxy/core";
import {
  type AccountRemovalCoordinator,
  asProviderRecord,
  createAccountRemovalCoordinator,
  oauthCapabilityOf,
} from "./account-removal";
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
  const enqueue = createFifoQueue();

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
          },
        },
      );
    } catch (error) {
      accountRemovals.compensate(staged);
      throw error;
    }

    void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
  }

  async function deleteProviderNow(providerId: string): Promise<void> {
    if (file === undefined) throw new ConfigPathMissingError();
    let cleanupPending: AccountCleanupPendingError | undefined;
    if (options.repository !== undefined) {
      let retired: RetiredProviderSnapshot | undefined;
      try {
        const operation = await deleteOAuthAccount({
          providerId,
          config: file,
          repository: options.repository,
          verify: async (candidate) => {
            retired = await verifyCandidate(candidate);
          },
        });
        void accountRemovals.finalizeAfterDrain([operation], retired).catch(() => {});
        return;
      } catch (error) {
        if (!(error instanceof AccountCleanupPendingError)) throw error;
        cleanupPending = error;
      }
    }

    await mutateProvidersNow((providers) => {
      if (oauthCapabilityOf(providerId, providers[providerId]) !== undefined && cleanupPending !== undefined) {
        throw cleanupPending;
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
