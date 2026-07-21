import type { Config } from "@aio-proxy/types";

import {
  AtomicConfigCommitUncertainError,
  type AtomicConfigFile,
  type PendingAccountOperation,
  parseRuntimeConfig,
} from "@aio-proxy/core";
import { ZodError } from "zod";

import type { SnapshotManager } from "../plugin-snapshot";
import type { RetiredProviderSnapshot } from "../runtime";
import type { ConfigReloadLog, ConfigReloadResult, ReloadFailure } from "./types";

import { type AccountRemovalCoordinator, asProviderRecord } from "../account-removal";
import { normalizeDashboardPassword } from "../dashboard-auth";
import { providerDiff } from "../provider-runtime";
import { providerConfigRecord, type Snapshot } from "./snapshot";

export async function reloadSnapshot({
  accountRemovals,
  commitConfig,
  configFile,
  logger,
  manager,
  onDashboardAuthHealthChanged = () => {},
  retainedOperations = [],
}: {
  readonly accountRemovals: AccountRemovalCoordinator;
  readonly commitConfig: (config: Config, reason: string) => Promise<RetiredProviderSnapshot>;
  readonly configFile: AtomicConfigFile | undefined;
  readonly logger: (entry: ConfigReloadLog) => void;
  readonly manager: SnapshotManager;
  readonly onDashboardAuthHealthChanged?: (available: boolean) => void;
  readonly retainedOperations?: readonly PendingAccountOperation[];
}): Promise<ConfigReloadResult> {
  try {
    const before = (manager.current() as Snapshot).summaries;
    if (configFile === undefined) await commitConfig((manager.current() as Snapshot).config, "reload");
    else
      await reloadConfigFile({
        accountRemovals,
        commitConfig,
        configFile,
        manager,
        onDashboardAuthHealthChanged,
        retainedOperations,
      });
    return { ok: true, diff: providerDiff(before, (manager.current() as Snapshot).summaries) };
  } catch (error) {
    const result = reloadError(error);
    logger({ error: result.error, event: "config.reload_failed", stage: result.stage });
    return result;
  }
}

async function reloadConfigFile({
  accountRemovals,
  commitConfig,
  configFile,
  manager,
  onDashboardAuthHealthChanged,
  retainedOperations,
}: {
  readonly accountRemovals: AccountRemovalCoordinator;
  readonly commitConfig: (config: Config, reason: string) => Promise<RetiredProviderSnapshot>;
  readonly configFile: AtomicConfigFile;
  readonly manager: SnapshotManager;
  readonly onDashboardAuthHealthChanged: (available: boolean) => void;
  readonly retainedOperations: readonly PendingAccountOperation[];
}): Promise<void> {
  const staged: PendingAccountOperation[] = [...retainedOperations];
  const newlyStaged: PendingAccountOperation[] = [];
  const retainedProviderIds = new Set(retainedOperations.map((operation) => operation.providerId));
  let retired: RetiredProviderSnapshot | undefined;
  let commitAfterWrite = false;
  let dashboardPasswordNormalized: boolean | undefined;
  try {
    await configFile.transaction(
      async (current) => {
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
        const detected = accountRemovals.stageRemoved(previousProviders, asProviderRecord(next["providers"]));
        newlyStaged.push(...detected);
        staged.push(...detected);
        commitAfterWrite = next !== current;
        if (!commitAfterWrite) retired = await commitConfig(parseRuntimeConfig(next), "reload");
        return { next, result: undefined };
      },
      {
        verify: async (candidate) => {
          if (commitAfterWrite) retired = await commitConfig(parseRuntimeConfig(candidate), "reload");
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
  void accountRemovals.finalizeAfterDrain(staged, retired).catch(() => {});
}

function reloadError(error: unknown): ReloadFailure {
  if (error instanceof SyntaxError || error instanceof ZodError)
    return { ok: false, error: error.message, stage: "parse" };
  if (error instanceof Error) {
    return {
      ok: false,
      error: error.message,
      stage: error.name === "RouterModelCollisionError" ? "alias-collision" : "providers",
    };
  }
  return { ok: false, error: String(error), stage: "providers" };
}
