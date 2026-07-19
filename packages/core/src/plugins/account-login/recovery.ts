import { ConfigSchema, providerLoginCommand } from "@aio-proxy/types";

import type { DiagnosticFactory, PluginLogSink } from "../diagnostic";
import type { PendingAccountOperation, PluginRepository } from "../repository/index";

import { AtomicConfigCommitUncertainError, type AtomicConfigFile, digestProviderEntry } from "../config-file";
import { AccountCleanupPendingError } from "./errors";
import {
  accountMatches,
  type ConfigRecord,
  capabilityOf,
  isRecord,
  providerRecord,
  structuredEntry,
  validateStagedOAuthWrite,
} from "./validation";

export const PENDING_OPERATION_TTL_MS = 30 * 60_000;
export const ORPHAN_ACCOUNT_GRACE_MS = 30 * 60_000;
export const RECOVERY_DRAIN_RETRY_MS = 5_000;
export const ABSENT_PROVIDER_DIGEST = "absent";

export type DeleteOAuthAccountOptions = {
  readonly providerId: string;
  readonly config: AtomicConfigFile;
  readonly repository: PluginRepository;
  readonly verify?: (candidate: Readonly<ConfigRecord>) => Promise<void>;
};
export type RecoverPendingAccountOperationsOptions =
  | { readonly mode: "cli"; readonly now?: () => number }
  | {
      readonly mode: "server";
      readonly canDeleteAccount: (providerId: string) => boolean;
      readonly deleteMarkerOnProviderPresent?: "complete" | "retain";
      readonly now?: () => number;
    };

export function safeSupersededDiagnostic(
  providerId: string,
  repository: PluginRepository,
  diagnostics?: DiagnosticFactory,
  logger?: PluginLogSink,
  now = Date.now(),
): void {
  if (repository.readAccount(providerId) === null) return;
  const suggestedCommand = providerLoginCommand(providerId);
  repository.writeDiagnostic(
    providerId,
    diagnostics?.("AUTHORIZATION_FAILED", { providerId, retryable: true, suggestedCommand }) ?? {
      code: "AUTHORIZATION_FAILED",
      summary: "ACCOUNT_OPERATION_SUPERSEDED",
      retryable: true,
      occurredAt: new Date(now).toISOString(),
      suggestedCommand,
    },
  );
  logger?.({
    event: "plugin.account.compensation.superseded",
    code: "AUTHORIZATION_FAILED",
    context: { providerId },
    error: { name: "Error", message: "ACCOUNT_OPERATION_SUPERSEDED" },
  });
}

export async function deleteOAuthAccount(options: DeleteOAuthAccountOptions): Promise<PendingAccountOperation> {
  let staged: PendingAccountOperation | undefined;
  try {
    staged = await options.config.transaction(
      async (current) => {
        const providers = providerRecord(current);
        const entry = structuredEntry(providers[options.providerId]);
        const account = options.repository.readAccount(options.providerId);
        if (entry === null || account === null || !accountMatches(account, capabilityOf(entry))) {
          throw new AccountCleanupPendingError(options.providerId);
        }
        const operation = options.repository.stageAccountOperation({
          kind: "delete",
          targetDigest: ABSENT_PROVIDER_DIGEST,
          providerId: options.providerId,
          expectedRuntimeRevision: account.runtimeRevision,
        });
        staged = operation;
        const { [options.providerId]: _removed, ...remaining } = providers;
        return { next: { ...current, providers: remaining }, result: operation };
      },
      {
        validateCandidate: validateStagedOAuthWrite,
        ...(options.verify === undefined ? {} : { verify: options.verify }),
      },
    );
    return staged;
  } catch (error) {
    if (staged !== undefined && !(error instanceof AtomicConfigCommitUncertainError)) {
      options.repository.compensateAccountOperation(staged.operationId);
    }
    throw error;
  }
}

const earlier = (current: number | undefined, candidate: number) =>
  current === undefined ? candidate : Math.min(current, candidate);

export async function recoverPendingAccountOperations(
  config: AtomicConfigFile,
  repository: PluginRepository,
  options: RecoverPendingAccountOperationsOptions,
  diagnostics?: { readonly factory: DiagnosticFactory; readonly logger: PluginLogSink },
): Promise<{ readonly nextRunAt?: number }> {
  const now = (options.now ?? Date.now)();
  let nextRunAt: number | undefined;
  await config.transaction(async (current) => {
    const rawProviders = current["providers"];
    if (rawProviders !== undefined && !isRecord(rawProviders)) {
      ConfigSchema.safeParse(current);
      nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
      return { next: current, result: undefined };
    }
    const providers = rawProviders ?? {};
    for (const operation of repository.listPendingAccountOperations()) {
      const deadline = operation.createdAt + PENDING_OPERATION_TTL_MS;
      if (now < deadline) {
        nextRunAt = earlier(nextRunAt, deadline);
        continue;
      }
      if (options.mode === "cli" && operation.kind === "delete") continue;
      const currentEntry = providers[operation.providerId];
      const observedDigest = currentEntry === undefined ? ABSENT_PROVIDER_DIGEST : digestProviderEntry(currentEntry);
      if (observedDigest === operation.targetDigest) {
        if (operation.kind === "delete") {
          if (options.mode !== "server") continue;
          if (!options.canDeleteAccount(operation.providerId)) {
            nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
            continue;
          }
          repository.finalizeDeleteOperation(operation.operationId);
        } else {
          repository.completeAccountOperation(operation.operationId);
        }
      } else if (operation.kind === "delete") {
        if (options.mode === "server" && options.deleteMarkerOnProviderPresent === "retain") {
          nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
        } else {
          repository.completeAccountOperation(operation.operationId);
        }
      } else if (repository.compensateAccountOperation(operation.operationId) === "superseded") {
        safeSupersededDiagnostic(operation.providerId, repository, diagnostics?.factory, diagnostics?.logger, now);
      }
    }
    const pendingProviderIds = new Set(
      repository.listPendingAccountOperations().map((operation) => operation.providerId),
    );
    for (const account of repository.listAccounts()) {
      if (Object.hasOwn(providers, account.providerId) || pendingProviderIds.has(account.providerId)) continue;
      const graceDeadline = account.updatedAt + ORPHAN_ACCOUNT_GRACE_MS;
      if (now < graceDeadline) {
        nextRunAt = earlier(nextRunAt, graceDeadline);
        continue;
      }
      if (options.mode !== "server") continue;
      if (!options.canDeleteAccount(account.providerId)) {
        nextRunAt = earlier(nextRunAt, now + RECOVERY_DRAIN_RETRY_MS);
        continue;
      }
      repository.deleteAccount(account.providerId);
    }
    return { next: current, result: undefined };
  });
  return nextRunAt === undefined ? {} : { nextRunAt };
}
