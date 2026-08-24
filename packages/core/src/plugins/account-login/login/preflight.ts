import type { StoredAccount } from '../../repository/index';
import {
  AccountCleanupPendingError,
  type OAuthCapabilityReference,
  OAuthCapabilityRequiredError,
  ProviderCapabilityTargetMismatchError,
} from '../errors';
import type { OAuthAccountWriteOptions } from '../login';
import { accountMatches, capabilityOf, isRecord, providerRecord, sameCapability, structuredEntry } from '../validation';

export type Preflight = {
  readonly capability: OAuthCapabilityReference;
  readonly hasEffectiveProxy: boolean;
  readonly account?: StoredAccount;
  readonly runtimeRevision?: number;
  readonly fingerprint?: string;
  readonly publicOptions: Readonly<Record<string, unknown>>;
  readonly secrets: Readonly<Record<string, unknown>>;
};

function hasEffectiveProxy(
  current: Readonly<Record<string, unknown>>,
  entry: Readonly<Record<string, unknown>> | null,
  patch: OAuthAccountWriteOptions['providerPatch'],
): boolean {
  const configuredProxy = entry?.['proxy'];
  const providerProxy = patch?.proxy === null ? undefined : (patch?.proxy ?? configuredProxy);
  if (providerProxy === false) return false;
  return typeof providerProxy === 'string' || typeof current['proxy'] === 'string';
}

export async function preflight(options: OAuthAccountWriteOptions, signal: AbortSignal): Promise<Preflight> {
  signal.throwIfAborted();
  const providerId = options.targetProviderId;
  if (providerId === undefined) {
    if (options.capability === undefined) throw new OAuthCapabilityRequiredError();
    const current = await options.config.read();
    signal.throwIfAborted();
    return {
      capability: options.capability,
      hasEffectiveProxy: hasEffectiveProxy(current, null, options.providerPatch),
      publicOptions: {},
      secrets: {},
    };
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
        .find((operation) => operation.providerId === providerId && operation.kind === 'delete');
      signal.throwIfAborted();
      if (pendingDelete !== undefined) options.repository.completeAccountOperation(pendingDelete.operationId);
      return {
        next: current,
        result: {
          capability,
          hasEffectiveProxy: hasEffectiveProxy(current, entry, options.providerPatch),
          account,
          runtimeRevision: account.runtimeRevision,
          fingerprint: account.fingerprint,
          publicOptions: isRecord(entry['options']) ? entry['options'] : {},
          secrets: isRecord(account.secrets) ? account.secrets : {},
        },
      };
    },
    { signal },
  );
}
