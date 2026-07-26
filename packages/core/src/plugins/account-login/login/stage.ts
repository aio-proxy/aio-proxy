import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';

import { digestProviderEntry } from '../../config-file';
import type { DiagnosticFactory } from '../../diagnostic/index';
import { resolveProviderId } from '../../provider-id';
import type { PendingAccountOperation, StoredAccount } from '../../repository/index';
import { AccountCleanupPendingError, ProviderAccountChangedError, ProviderFingerprintMismatchError } from '../errors';
import type { LoginOAuthAccountOptions } from '../login';
import {
  accountMatches,
  capabilityOf,
  type ConfigRecord,
  duplicateOrCleanup,
  type PlainRecord,
  providerEntry,
  providerRecord,
  sameCapability,
  structuredEntry,
  validatedDefaultAliases,
} from '../validation';
import type { Preflight } from './preflight';

export type CatalogDiscovery =
  | { readonly kind: 'success'; readonly catalog: ModelCatalog }
  | { readonly kind: 'failure'; readonly error: unknown };

export type StageContext = {
  readonly options: LoginOAuthAccountOptions;
  readonly initial: Preflight;
  readonly adapter: OAuthAdapter;
  readonly discovered: CatalogDiscovery;
  readonly publicValues: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
  readonly currentCredential: () => unknown;
  readonly fingerprint: string;
  readonly suggestedKey: string;
  readonly metadata: { label?: string; expiresAt?: number };
  readonly diagnostics: DiagnosticFactory;
  readonly signal: AbortSignal;
};

export type StageState = { operation?: PendingAccountOperation; providerId?: string };

type ResolvedTarget = {
  readonly providerId: string;
  readonly existingEntry: PlainRecord | undefined;
  readonly currentAccount: StoredAccount | null;
};

export type StageWrite = { readonly next: ConfigRecord; readonly result: PendingAccountOperation };

export function stageAccountWrite(current: ConfigRecord, ctx: StageContext, state: StageState): StageWrite {
  ctx.signal.throwIfAborted();
  const providers = providerRecord(current);
  const { providerId, existingEntry, currentAccount } = resolveTarget(current, ctx, providers);
  const entry = buildProviderEntry(ctx, providers, providerId, existingEntry, currentAccount);
  const account = buildAccountWrite(ctx, providerId, currentAccount);
  ctx.signal.throwIfAborted();
  const targetDigest = digestProviderEntry(entry);
  const operation =
    currentAccount === null
      ? ctx.options.repository.stageAccountOperation({ kind: 'create', targetDigest, account })
      : ctx.options.repository.stageAccountOperation({
          kind: 'update',
          targetDigest,
          expectedRuntimeRevision: ctx.initial.runtimeRevision as number,
          account,
        });
  state.operation = operation;
  state.providerId = providerId;
  return { next: { ...current, providers: { ...providers, [providerId]: entry } }, result: operation };
}

function resolveTarget(current: ConfigRecord, ctx: StageContext, providers: Record<string, unknown>): ResolvedTarget {
  const { options, initial, fingerprint, suggestedKey } = ctx;
  const existingFingerprint = options.repository.findAccountByFingerprint(
    initial.capability.plugin,
    initial.capability.capability,
    fingerprint,
  );
  if (options.targetProviderId === undefined) {
    if (existingFingerprint !== null) {
      const pending = options.repository
        .listPendingAccountOperations()
        .some((operation) => operation.providerId === existingFingerprint.providerId);
      if (pending) throw new AccountCleanupPendingError(existingFingerprint.providerId);
      throw duplicateOrCleanup(existingFingerprint, providers);
    }
    const resolution = resolveProviderId({
      plugin: initial.capability.plugin,
      capability: initial.capability.capability,
      fingerprint,
      suggestedKey,
      providerIds: Object.keys(providers),
      accounts: options.repository.listAccounts(),
    });
    if (resolution.status === 'existing') {
      const existing = options.repository.readAccount(resolution.providerId);
      if (existing === null) throw new AccountCleanupPendingError(resolution.providerId);
      if (
        options.repository
          .listPendingAccountOperations()
          .some((operation) => operation.providerId === resolution.providerId)
      )
        throw new AccountCleanupPendingError(resolution.providerId);
      throw duplicateOrCleanup(existing, providers);
    }
    return { providerId: resolution.providerId, existingEntry: undefined, currentAccount: null };
  }
  const providerId = options.targetProviderId;
  const existingEntry = structuredEntry(providers[providerId]) ?? undefined;
  const currentAccount = options.repository.readAccount(providerId);
  const pending = options.repository
    .listPendingAccountOperations()
    .find((operation) => operation.providerId === providerId);
  if (
    existingEntry === undefined ||
    currentAccount === null ||
    pending !== undefined ||
    initial.runtimeRevision !== currentAccount.runtimeRevision ||
    initial.fingerprint !== currentAccount.fingerprint ||
    !accountMatches(currentAccount, initial.capability) ||
    !sameCapability(capabilityOf(existingEntry), initial.capability)
  )
    throw new ProviderAccountChangedError(providerId);
  if (fingerprint !== currentAccount.fingerprint) throw new ProviderFingerprintMismatchError(providerId);
  return { providerId, existingEntry, currentAccount };
}

function buildProviderEntry(
  ctx: StageContext,
  providers: Record<string, unknown>,
  providerId: string,
  existingEntry: PlainRecord | undefined,
  currentAccount: StoredAccount | null,
): PlainRecord {
  const defaults =
    currentAccount === null && ctx.discovered.kind === 'success'
      ? validatedDefaultAliases(ctx.adapter, ctx.discovered.catalog)
      : undefined;
  return providerEntry(
    ctx.initial.capability.plugin,
    ctx.initial.capability.capability,
    ctx.publicValues,
    existingEntry,
    defaults,
    ctx.options.providerPatch,
  );
}

function buildAccountWrite(ctx: StageContext, providerId: string, currentAccount: StoredAccount | null) {
  const { initial, discovered, metadata } = ctx;
  const catalogDiagnostic = ctx.diagnostics('CATALOG_UNAVAILABLE', {
    plugin: initial.capability.plugin,
    capability: initial.capability.capability,
    providerId,
    retryable: true,
  });
  return {
    providerId,
    plugin: initial.capability.plugin,
    capability: initial.capability.capability,
    fingerprint: ctx.fingerprint,
    options: ctx.publicValues,
    secrets: ctx.secrets,
    credential: ctx.currentCredential(),
    ...(metadata.label === undefined ? {} : { label: metadata.label }),
    ...(metadata.expiresAt === undefined ? {} : { expiresAt: metadata.expiresAt }),
    catalog:
      discovered.kind === 'success'
        ? ({
            kind: 'replace',
            value: { catalog: discovered.catalog, refreshedAt: (ctx.options.now ?? Date.now)() },
          } as const)
        : currentAccount === null
          ? ({ kind: 'missing', diagnostic: catalogDiagnostic } as const)
          : ({ kind: 'preserve', diagnostic: catalogDiagnostic } as const),
  };
}
