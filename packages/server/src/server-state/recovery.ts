import {
  type AtomicConfigFile,
  type DiagnosticFactory,
  type PendingAccountOperation,
  type PluginLogSink,
  type PluginRepository,
  RECOVERY_DRAIN_RETRY_MS,
  type recoverPendingAccountOperations,
} from "@aio-proxy/core";
import type { FifoQueue } from "../fifo-queue";
import type { ConfigReloadResult, RecoveryScheduler, RecoveryTimer } from "./types";

type RecoverAccounts = typeof recoverPendingAccountOperations;

export function defaultRecoveryScheduler(): RecoveryScheduler {
  return {
    now: Date.now,
    setTimeout(callback, delayMs) {
      const timer = setTimeout(callback, delayMs);
      timer.unref?.();
      return { clear: () => clearTimeout(timer) };
    },
  };
}

export async function recoverBeforeSnapshot(options: {
  readonly configFile: AtomicConfigFile | undefined;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly recoverAccounts: RecoverAccounts;
  readonly scheduler: RecoveryScheduler;
  readonly enqueue: FifoQueue;
}): Promise<void> {
  if (options.configFile === undefined) return;
  await options.enqueue(() =>
    options.recoverAccounts(
      options.configFile as AtomicConfigFile,
      options.repository,
      {
        mode: "server",
        canDeleteAccount: () => true,
        deleteMarkerOnProviderPresent: "retain",
        now: options.scheduler.now,
      },
      { factory: options.diagnostics, logger: options.logger },
    ),
  );
}

export function createRecovery(options: {
  readonly configFile: AtomicConfigFile | undefined;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly recoverAccounts: RecoverAccounts;
  readonly scheduler: RecoveryScheduler;
  readonly reconciliationRetryMs: number;
  readonly enqueue: FifoQueue;
  readonly canDeleteAccount: (providerId: string) => boolean;
  readonly reloadNow: (operations?: readonly PendingAccountOperation[]) => Promise<ConfigReloadResult>;
}) {
  let timer: RecoveryTimer | undefined;
  let runAt: number | undefined;
  const reconciliationTimers = new Set<ReturnType<typeof setTimeout>>();
  let generation = 0;
  let closed = false;

  function scheduleReconciliation(operations: readonly PendingAccountOperation[], expected = generation): void {
    if (closed || expected !== generation) return;
    void options
      .enqueue(async () => {
        if (closed || expected !== generation) return;
        try {
          const result = await options.reloadNow(operations);
          if (!result.ok) scheduleReconciliationRetry(operations, expected);
        } catch {
          scheduleReconciliationRetry(operations, expected);
        }
      })
      .catch(() => scheduleReconciliationRetry(operations, expected));
  }

  function scheduleReconciliationRetry(operations: readonly PendingAccountOperation[], expected: number): void {
    if (closed || expected !== generation) return;
    const retryTimer = setTimeout(() => {
      reconciliationTimers.delete(retryTimer);
      scheduleReconciliation(operations, expected);
    }, options.reconciliationRetryMs);
    reconciliationTimers.add(retryTimer);
    retryTimer.unref?.();
  }

  async function run(expected: number): Promise<void> {
    if (closed || expected !== generation || options.configFile === undefined) return;
    try {
      const result = await options.recoverAccounts(
        options.configFile,
        options.repository,
        {
          mode: "server",
          canDeleteAccount: options.canDeleteAccount,
          deleteMarkerOnProviderPresent: "retain",
          now: options.scheduler.now,
        },
        { factory: options.diagnostics, logger: options.logger },
      );
      if (closed || expected !== generation) return;
      if (result.nextRunAt !== undefined) schedule(result.nextRunAt, expected);
    } catch (error) {
      if (closed || expected !== generation) return;
      schedule(options.scheduler.now() + RECOVERY_DRAIN_RETRY_MS, expected);
      try {
        options.logger({
          event: "plugin.account.recovery.failed",
          code: "ACCOUNT_RECOVERY_FAILED",
          context: {},
          error: { name: error instanceof Error ? error.name : "Error", message: "Pending account recovery failed" },
        });
      } catch {}
    }
  }

  function schedule(nextRunAt: number, expected = generation): void {
    if (closed || expected !== generation) return;
    if (timer !== undefined && runAt !== undefined && runAt <= nextRunAt) return;
    timer?.clear();
    runAt = nextRunAt;
    timer = options.scheduler.setTimeout(
      () => {
        timer = undefined;
        runAt = undefined;
        if (closed || expected !== generation) return;
        void options.enqueue(() => run(expected)).catch(() => {});
      },
      Math.max(0, nextRunAt - options.scheduler.now()),
    );
  }

  return {
    async start(): Promise<void> {
      if (options.configFile === undefined) return;
      const recovered = await options.enqueue(() =>
        options.recoverAccounts(
          options.configFile as AtomicConfigFile,
          options.repository,
          {
            mode: "server",
            canDeleteAccount: options.canDeleteAccount,
            deleteMarkerOnProviderPresent: "retain",
            now: options.scheduler.now,
          },
          { factory: options.diagnostics, logger: options.logger },
        ),
      );
      if (recovered.nextRunAt !== undefined) schedule(recovered.nextRunAt);
    },
    schedule,
    scheduleReconciliation,
    close() {
      if (closed) return;
      closed = true;
      generation++;
      timer?.clear();
      timer = undefined;
      runAt = undefined;
      for (const retryTimer of reconciliationTimers) clearTimeout(retryTimer);
      reconciliationTimers.clear();
    },
  };
}
