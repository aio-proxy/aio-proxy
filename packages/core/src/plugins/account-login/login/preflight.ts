import type { StoredAccount } from "../../repository/index";
import {
  AccountCleanupPendingError,
  type OAuthCapabilityReference,
  OAuthCapabilityRequiredError,
  ProviderCapabilityTargetMismatchError,
} from "../errors";
import type { LoginOAuthAccountOptions } from "../login";
import { accountMatches, capabilityOf, isRecord, providerRecord, sameCapability, structuredEntry } from "../validation";

export type Preflight = {
  readonly capability: OAuthCapabilityReference;
  readonly account?: StoredAccount;
  readonly runtimeRevision?: number;
  readonly fingerprint?: string;
  readonly publicOptions: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, unknown>>;
};

export async function preflight(options: LoginOAuthAccountOptions, signal: AbortSignal): Promise<Preflight> {
  signal.throwIfAborted();
  const providerId = options.targetProviderId;
  if (providerId === undefined) {
    if (options.capability === undefined) throw new OAuthCapabilityRequiredError();
    return { capability: options.capability, publicOptions: {}, secrets: {} };
  }
  return options.config.transaction(
    async (current) => {
      signal.throwIfAborted();
      const entry = structuredEntry(providerRecord(current)[providerId]);
      const account = options.repository.readAccount(providerId);
      if (entry === null || account === null) throw new AccountCleanupPendingError(providerId);
      const capability = capabilityOf(entry);
      if (!accountMatches(account, capability)) throw new AccountCleanupPendingError(providerId);
      if (options.capability !== undefined && !sameCapability(options.capability, capability)) {
        throw new ProviderCapabilityTargetMismatchError(options.capability, capability);
      }
      const pendingDelete = options.repository
        .listPendingAccountOperations()
        .find((operation) => operation.providerId === providerId && operation.kind === "delete");
      signal.throwIfAborted();
      if (pendingDelete !== undefined) options.repository.completeAccountOperation(pendingDelete.operationId);
      return {
        next: current,
        result: {
          capability,
          account,
          runtimeRevision: account.runtimeRevision,
          fingerprint: account.fingerprint,
          publicOptions: isRecord(entry["options"]) ? entry["options"] : {},
          secrets: isRecord(account.secrets) ? account.secrets : {},
        },
      };
    },
    { signal },
  );
}
