import { type StoredCatalog, validateModelCatalog } from '@aio-proxy/core';
import type { AccountContext, CredentialPort } from '@aio-proxy/plugin-sdk';
import { type Diagnostic, providerLoginCommand } from '@aio-proxy/types';

import {
  OAuthPluginAccountPreparationError,
  type PreparedOAuthPluginAccount,
  prepareOAuthPluginAccount,
} from '../plugin-account';
import type { RuntimeProviderInstance } from '../runtime';
import { catalogRouteIds, createRuntimeProvider, withRoutingConfig } from './capabilities';
import {
  catalogDiagnostic,
  catalogFreshness,
  diagnosticState,
  failure,
  pluginVersion,
  refreshDiagnostic,
  summary,
} from './catalog';
import { digest, runtimeIdentity } from './identity';
import {
  type CatalogJobDescriptor,
  type MaterializePluginProviderOptions,
  PLUGIN_RUNTIME_TIMEOUT_MS,
  type PluginProviderMaterialization,
  type RuntimeIdentityKey,
} from './types';

function runtimeDeadline<T>(task: Promise<T>): Promise<T> {
  task.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Plugin runtime creation timed out')), PLUGIN_RUNTIME_TIMEOUT_MS);
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function readStoredCatalog(
  repository: MaterializePluginProviderOptions['repository'],
  providerId: string,
): { readonly storedCatalog: StoredCatalog | null; readonly catalogReadFailed: boolean } {
  let catalogReadFailed = false;
  let storedCatalog: StoredCatalog | null;
  try {
    storedCatalog = repository.readCatalog(providerId);
  } catch {
    catalogReadFailed = true;
    storedCatalog = null;
  }
  if (storedCatalog !== null) {
    try {
      storedCatalog = { ...storedCatalog, catalog: validateModelCatalog(storedCatalog.catalog) };
    } catch {
      storedCatalog = null;
    }
  }
  return { storedCatalog, catalogReadFailed };
}

type PersistedSummary = (
  provider: RuntimeProviderInstance | undefined,
  catalog: StoredCatalog | null,
) => PluginProviderMaterialization['summary'];
type CatalogJobFor = (credentials: CredentialPort<unknown>) => CatalogJobDescriptor;

function catalogUnavailableMaterialization(
  options: MaterializePluginProviderOptions,
  unavailable: Diagnostic | undefined,
  persistedSummary: PersistedSummary,
  catalogJobFor: CatalogJobFor,
  createCredentials: () => CredentialPort<unknown>,
): PluginProviderMaterialization {
  const { config } = options;
  const diagnostic =
    unavailable ??
    options.diagnostics('CATALOG_UNAVAILABLE', {
      plugin: config.plugin,
      capability: config.capability,
      providerId: config.id,
      retryable: true,
    });
  if (!config.enabled) return { summary: persistedSummary(undefined, null), state: diagnosticState(diagnostic) };
  const credentials = createCredentials();
  return {
    summary: persistedSummary(undefined, null),
    state: diagnosticState(diagnostic),
    catalogJob: catalogJobFor(credentials),
  };
}

async function createRuntimeMaterialization(
  options: MaterializePluginProviderOptions,
  adapter: PreparedOAuthPluginAccount['adapter'],
  accountOptions: unknown,
  storedCatalog: StoredCatalog,
  identity: RuntimeIdentityKey,
  credentials: CredentialPort<unknown>,
  catalogJob: CatalogJobDescriptor,
  state: PluginProviderMaterialization['state'],
  persistedSummary: PersistedSummary,
  accountSummary: PreparedOAuthPluginAccount['accountSummary'],
): Promise<PluginProviderMaterialization> {
  const { config } = options;
  const fetch = options.runtimeFetch ?? globalThis.fetch;
  try {
    const result = await runtimeDeadline(
      Promise.resolve().then(() =>
        adapter.createRuntime({
          credentials: credentials as never,
          options: accountOptions,
          catalog: storedCatalog.catalog,
          fetch,
        }),
      ),
    );
    const provider = createRuntimeProvider(config, result, storedCatalog.catalog);
    const cacheEntry = { identity, provider, credentials, fetch };
    return { provider, summary: persistedSummary(provider, storedCatalog), state, catalogJob, cacheEntry };
  } catch (error) {
    options.logger({
      event: 'plugin.runtime.create.failed',
      code: 'RUNTIME_CREATE_FAILED',
      context: { plugin: config.plugin, capability: config.capability, providerId: config.id },
      error: { name: error instanceof Error ? error.name : 'Error', message: 'Plugin runtime creation failed' },
    });
    return failure(options, 'RUNTIME_CREATE_FAILED', true, undefined, accountSummary);
  }
}

export async function materializePluginProvider(
  options: MaterializePluginProviderOptions,
): Promise<PluginProviderMaterialization> {
  const { config, plugins, repository } = options;
  let prepared: PreparedOAuthPluginAccount;
  try {
    prepared = await prepareOAuthPluginAccount(options);
  } catch (error) {
    if (!(error instanceof OAuthPluginAccountPreparationError)) throw error;
    return failure(
      options,
      error.code,
      false,
      error.suggestLogin ? providerLoginCommand(options.config.id) : undefined,
      error.accountSummary,
    );
  }
  const { adapter, account, accountOptions, accountSummary, createCredentials } = prepared;
  let proxyIdentity = options.effectiveProxy;
  if (proxyIdentity === undefined) proxyIdentity = config.proxy === false ? null : (config.proxy ?? null);
  if (adapter.supportsProxy === false && proxyIdentity !== null) {
    return failure(options, 'PROXY_UNSUPPORTED', false, undefined, accountSummary);
  }
  const accountOptionsDigest = digest(prepared.accountOptionsIdentity);
  let diagnostics: readonly Diagnostic[];
  try {
    diagnostics = repository.readDiagnostics(config.id);
  } catch {
    return failure(options, 'CREDENTIALS_MISSING_OR_INVALID', false, providerLoginCommand(config.id), accountSummary);
  }
  const refreshFailure = refreshDiagnostic(diagnostics);
  if (refreshFailure !== undefined) {
    return {
      summary: summary(config, undefined, accountSummary),
      state: diagnosticState({ ...refreshFailure, suggestedCommand: providerLoginCommand(config.id) }),
    };
  }

  const { storedCatalog, catalogReadFailed } = readStoredCatalog(repository, config.id);

  const unavailable =
    catalogDiagnostic(diagnostics) ??
    (catalogReadFailed
      ? options.diagnostics('CATALOG_UNAVAILABLE', {
          plugin: config.plugin,
          capability: config.capability,
          providerId: config.id,
          retryable: true,
        })
      : undefined);
  const persistedSummary = (provider: Parameters<typeof summary>[1], catalog: typeof storedCatalog) =>
    summary(config, provider, {
      ...accountSummary,
      ...(catalog === null ? {} : { catalogLastSuccessAt: new Date(catalog.refreshedAt).toISOString() }),
    });
  const defaultAliases = adapter.catalog.defaultAliases;
  const catalogJobFor = (credentials: CredentialPort<unknown>): CatalogJobDescriptor => ({
    providerId: config.id,
    plugin: account.plugin,
    capability: account.capability,
    accountRuntimeRevision: account.runtimeRevision,
    policy: adapter.catalog.policy,
    stored: storedCatalog,
    ...(unavailable === undefined ? {} : { unavailableOccurredAt: Date.parse(unavailable.occurredAt) }),
    ...(defaultAliases === undefined ? {} : { defaultAliases }),
    discover: (signal) =>
      adapter.catalog.discover({
        credentials: credentials as never,
        options: accountOptions,
        signal,
        ...(options.runtimeFetch === undefined ? {} : { fetch: options.runtimeFetch }),
      } as unknown as AccountContext<unknown, unknown>),
  });

  if (storedCatalog === null) {
    return catalogUnavailableMaterialization(options, unavailable, persistedSummary, catalogJobFor, createCredentials);
  }

  const identity = runtimeIdentity({
    packageName: config.plugin,
    version: pluginVersion(plugins, config.plugin),
    capability: config.capability,
    providerId: config.id,
    pluginOptionsDigest: options.pluginOptionsDigest,
    accountOptionsDigest,
    requestTransformsDigest: digest(config.transforms?.request ?? []),
    proxyDigest: digest(proxyIdentity),
    runtimeRevision: account.runtimeRevision,
    catalogDigest: digest(storedCatalog.catalog),
    catalogRefreshedAt: storedCatalog.refreshedAt,
  });
  const state = {
    status: 'ready',
    catalog: catalogFreshness(adapter.catalog.policy, storedCatalog, unavailable),
    ...(unavailable === undefined ? {} : { diagnostic: unavailable }),
  } as const;
  if (!config.enabled) {
    const cacheEntry =
      options.previous?.identity === identity
        ? {
            ...options.previous,
            provider: withRoutingConfig(options.previous.provider, config, catalogRouteIds(storedCatalog.catalog)),
          }
        : undefined;
    return {
      summary: persistedSummary(undefined, storedCatalog),
      state,
      ...(cacheEntry === undefined ? {} : { cacheEntry }),
    };
  }
  const credentials = options.previous?.identity === identity ? options.previous.credentials : createCredentials();
  const catalogJob = catalogJobFor(credentials);
  if (options.previous?.identity === identity) {
    const provider = withRoutingConfig(options.previous.provider, config, catalogRouteIds(storedCatalog.catalog));
    const cacheEntry = { ...options.previous, provider };
    return { provider, summary: persistedSummary(provider, storedCatalog), state, catalogJob, cacheEntry };
  }

  return createRuntimeMaterialization(
    options,
    adapter,
    accountOptions,
    storedCatalog,
    identity,
    credentials,
    catalogJob,
    state,
    persistedSummary,
    accountSummary,
  );
}
