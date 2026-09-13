import {
  AtomicConfigCommitUncertainError,
  type AtomicConfigFile,
  type PendingAccountOperation,
  parseRuntimeConfig,
} from '@aio-proxy/core';
import type { Config } from '@aio-proxy/types';
import { ZodError } from 'zod';

import { type AccountRemovalCoordinator, asProviderRecord } from '../account-removal';
import { warnLeftoverOAuthModels } from '../config-leftover-oauth-models';
import { normalizeDashboardPassword } from '../dashboard-auth';
import type { SnapshotManager } from '../plugin-snapshot';
import { providerDiff } from '../provider-runtime';
import type { RetiredProviderSnapshot } from '../runtime';
import type { ServerLogSink } from '../server-log';
import type { SyncCommitHooks } from '../sync-control-plane/commit';
import { providerConfigRecord, type Snapshot } from './snapshot';
import type { ConfigReloadResult, ReloadFailure } from './types';

export async function reloadSnapshot({
  accountRemovals,
  commitConfig,
  configFile,
  logger,
  manager,
  onDashboardAuthHealthChanged = () => {},
  retainedOperations = [],
  syncCommit,
}: {
  readonly accountRemovals: AccountRemovalCoordinator;
  readonly commitConfig: (config: Config, reason: string) => Promise<RetiredProviderSnapshot>;
  readonly configFile: AtomicConfigFile | undefined;
  readonly logger: ServerLogSink;
  readonly manager: SnapshotManager;
  readonly onDashboardAuthHealthChanged?: (available: boolean) => void;
  readonly retainedOperations?: readonly PendingAccountOperation[];
  readonly syncCommit?: SyncCommitHooks;
}): Promise<ConfigReloadResult> {
  try {
    const before = (manager.current() as Snapshot).summaries;
    if (configFile === undefined) await commitConfig((manager.current() as Snapshot).config, 'reload');
    else
      await reloadConfigFile({
        accountRemovals,
        commitConfig,
        configFile,
        logger,
        manager,
        onDashboardAuthHealthChanged,
        retainedOperations,
        syncCommit,
      });
    return { ok: true, diff: providerDiff(before, (manager.current() as Snapshot).summaries) };
  } catch (error) {
    const result = reloadError(error);
    logger({ error: result.error, event: 'config.reload_failed', stage: result.stage });
    return result;
  }
}

async function reloadConfigFile({
  accountRemovals,
  commitConfig,
  configFile,
  logger,
  manager,
  onDashboardAuthHealthChanged,
  retainedOperations,
  syncCommit,
}: {
  readonly accountRemovals: AccountRemovalCoordinator;
  readonly commitConfig: (config: Config, reason: string) => Promise<RetiredProviderSnapshot>;
  readonly configFile: AtomicConfigFile;
  readonly logger: ServerLogSink;
  readonly manager: SnapshotManager;
  readonly onDashboardAuthHealthChanged: (available: boolean) => void;
  readonly retainedOperations: readonly PendingAccountOperation[];
  readonly syncCommit?: SyncCommitHooks;
}): Promise<void> {
  const staged: PendingAccountOperation[] = [...retainedOperations];
  const newlyStaged: PendingAccountOperation[] = [];
  const retainedProviderIds = new Set(retainedOperations.map((operation) => operation.providerId));
  let retired: RetiredProviderSnapshot | undefined;
  let commitAfterWrite = false;
  let dashboardPasswordNormalized: boolean | undefined;
  let before: Record<string, unknown> | undefined;
  let commitId: string | undefined;
  try {
    await configFile.transaction(
      async (current) => {
        before = current;
        let next: Record<string, unknown>;
        try {
          next = await normalizeDashboardPassword(current);
          dashboardPasswordNormalized = true;
        } catch (error) {
          dashboardPasswordNormalized = false;
          throw error;
        }
        const previous = manager.current() as Snapshot;
        const previousProviders = Object.fromEntries(
          Object.entries(providerConfigRecord(previous.config)).filter(
            ([providerId]) => !retainedProviderIds.has(providerId),
          ),
        );
        const detected = accountRemovals.stageRemoved(previousProviders, asProviderRecord(next['providers']));
        newlyStaged.push(...detected);
        staged.push(...detected);
        commitAfterWrite = next !== current;
        if (!commitAfterWrite) {
          warnLeftoverOAuthModels(next, logger);
          retired = await commitConfig(parseRuntimeConfig(next), 'reload');
        }
        return { next, result: undefined };
      },
      {
        verify: async (candidate) => {
          if (commitAfterWrite) {
            warnLeftoverOAuthModels(candidate, logger);
            retired = await commitConfig(parseRuntimeConfig(candidate), 'reload');
          }
        },
        beforeCommit: async (candidate) => {
          if (syncCommit !== undefined && before !== undefined)
            commitId = syncCommit.prepare(
              before,
              candidate,
              staged.map((operation) => operation.operationId),
            );
        },
      },
    );
  } catch (error) {
    if (dashboardPasswordNormalized === false) onDashboardAuthHealthChanged(false);
    if (retired !== undefined) void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
    else if (error instanceof AtomicConfigCommitUncertainError) accountRemovals.scheduleRecovery(staged);
    else accountRemovals.compensate(newlyStaged);
    throw error;
  }
  onDashboardAuthHealthChanged(true);
  if (commitId !== undefined) void syncCommit?.confirm(commitId).catch(() => {});
  void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
}

function reloadError(error: unknown): ReloadFailure {
  if (error instanceof SyntaxError || error instanceof ZodError)
    return { ok: false, error: error.message, stage: 'parse' };
  if (error instanceof Error) {
    return {
      ok: false,
      error: error.message,
      stage: error.name === 'RouterModelCollisionError' ? 'alias-collision' : 'providers',
    };
  }
  return { ok: false, error: String(error), stage: 'providers' };
}
