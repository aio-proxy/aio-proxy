import {
  AtomicConfigCommitUncertainError,
  AtomicConfigFile,
  parseRuntimeConfig,
  type PendingAccountOperation,
  type PluginRepository,
} from '@aio-proxy/core';
import type { LocalCommitPort, SyncRepository } from '@aio-proxy/core';

import { type AccountRemovalCoordinator, asProviderRecord, createAccountRemovalCoordinator } from '../account-removal';
import type { FifoQueue } from '../fifo-queue';
import { createFifoQueue } from '../fifo-queue';
import type { RetiredProviderSnapshot } from '../runtime';
import { createSyncCommitHooks, type SyncCommitHooks } from '../sync-control-plane/commit';

export class ConfigPathMissingError extends Error {
  constructor() {
    super('config file path is not configured');
    this.name = 'ConfigPathMissingError';
  }
}

export class ConfigReloadRejectedError extends Error {
  constructor(reason: string) {
    super(`config reload rejected: ${reason}`);
    this.name = 'ConfigReloadRejectedError';
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
  readonly syncCommit?:
    | SyncCommitHooks
    | { readonly repo: SyncRepository; readonly bindingId: string; readonly port: LocalCommitPort };
};

export type ConfigStore = {
  readonly coordinateProviderMutation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly file: AtomicConfigFile | undefined;
  readonly deleteProvider: (providerId: string) => Promise<void>;
  readonly mutateConfig: (
    fn: (record: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ) => Promise<void>;
  readonly mutateConfigWithProviderMutation: <T>(
    fn: (record: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
    beforeOperation: (assertConfigOwnership: () => Promise<void>) => Promise<void>,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readonly mutateProviders: (fn: (record: Record<string, unknown>) => Record<string, unknown>) => Promise<void>;
};

export function createConfigStore(options: ConfigStoreOptions): ConfigStore {
  const path = options.getConfigPath();
  const file = options.file ?? (path === undefined ? undefined : new AtomicConfigFile(path));
  const accountRemovals =
    options.accountRemovals ?? createAccountRemovalCoordinator({ file, repository: options.repository });
  const enqueue = options.enqueue ?? createFifoQueue();

  function enqueueProviderMutation<T>(operation: () => Promise<T>): Promise<T> {
    return enqueue(operation);
  }

  const syncCapture =
    options.syncCommit === undefined
      ? undefined
      : 'prepare' in options.syncCommit
        ? options.syncCommit
        : createSyncCommitHooks({ path: path ?? 'config.jsonc', ...options.syncCommit });
  const confirm = async (commitId: string | undefined): Promise<void> => {
    if (syncCapture !== undefined && commitId !== undefined) await syncCapture.confirm(commitId);
  };

  async function verifyCandidate(
    candidate: Readonly<Record<string, unknown>>,
  ): Promise<RetiredProviderSnapshot | undefined> {
    try {
      return await options.verify(candidate);
    } catch (error) {
      throw new ConfigReloadRejectedError(error instanceof Error ? error.message : String(error));
    }
  }

  async function mutateProvidersNow(
    fn: (record: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<string | undefined> {
    if (file === undefined) throw new ConfigPathMissingError();
    const staged: PendingAccountOperation[] = [];
    let before: Record<string, unknown> | undefined;
    let commitId: string | undefined;
    let retired: RetiredProviderSnapshot | undefined;
    let verificationCompleted = false;
    try {
      await file.transaction(
        async (current) => {
          before = current;
          const providers = asProviderRecord(current['providers']);
          const nextProviders = fn(providers);
          if (nextProviders === providers) return { next: current, result: undefined };
          staged.push(...accountRemovals.stageRemoved(providers, nextProviders));
          return { next: { ...current, providers: nextProviders }, result: undefined };
        },
        {
          verify: async (candidate) => {
            retired = await verifyCandidate(candidate);
            verificationCompleted = true;
          },
          beforeCommit: async (candidate) => {
            if (syncCapture !== undefined && before !== undefined)
              commitId = syncCapture.prepare(
                before,
                candidate,
                staged.map((operation) => operation.operationId),
              );
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
    return commitId;
  }

  async function mutateConfigNow(
    fn: (record: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<string | undefined> {
    if (file === undefined) throw new ConfigPathMissingError();
    let before: Record<string, unknown> | undefined;
    let commitId: string | undefined;
    await file.replace(
      async (current) => {
        before = current;
        return fn(current);
      },
      {
        validateCandidate: (candidate) => void parseRuntimeConfig(candidate),
        verify: async (candidate) => void (await verifyCandidate(candidate)),
        beforeCommit: async (candidate) => {
          if (syncCapture !== undefined && before !== undefined) commitId = syncCapture.prepare(before, candidate);
        },
      },
    );
    return commitId;
  }

  async function mutateConfigWithProviderMutationNow<T>(
    fn: (record: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>,
    beforeOperation: (assertConfigOwnership: () => Promise<void>) => Promise<void>,
    operation: () => Promise<T>,
  ): Promise<{ readonly value: T; readonly commitId?: string }> {
    if (file === undefined) throw new ConfigPathMissingError();
    let operationResult: { readonly value: T } | undefined;
    let before: Record<string, unknown> | undefined;
    let commitId: string | undefined;
    await file.replace(
      async (current) => {
        before = current;
        return fn(current);
      },
      {
        validateCandidate: (candidate) => void parseRuntimeConfig(candidate),
        verify: async (candidate) => void (await verifyCandidate(candidate)),
        beforeCommit: async (candidate, assertConfigOwnership) => {
          if (syncCapture !== undefined && before !== undefined) commitId = syncCapture.prepare(before, candidate);
          await beforeOperation(assertConfigOwnership);
        },
        afterCommit: async () => {
          operationResult = { value: await operation() };
        },
      },
    );
    if (operationResult === undefined) throw new Error('Provider mutation operation did not run');
    return { ...operationResult, ...(commitId === undefined ? {} : { commitId }) };
  }

  return {
    coordinateProviderMutation: enqueueProviderMutation,
    deleteProvider: (providerId) =>
      enqueue(async () => {
        const commitId = await mutateProvidersNow((providers) => {
          const { [providerId]: _removed, ...remaining } = providers;
          return remaining;
        });
        return commitId;
      }).then(async (commitId) => {
        await confirm(commitId);
      }),
    file,
    mutateConfig: (fn) =>
      enqueue(() => mutateConfigNow(fn)).then(async (commitId) => {
        await confirm(commitId);
      }),
    mutateConfigWithProviderMutation: (fn, beforeOperation, operation) =>
      enqueue(() => mutateConfigWithProviderMutationNow(fn, beforeOperation, operation)).then(async (result) => {
        await confirm(result.commitId);
        return result.value;
      }),
    mutateProviders: (fn) =>
      enqueue(() => mutateProvidersNow(fn)).then(async (commitId) => {
        await confirm(commitId);
      }),
  };
}
