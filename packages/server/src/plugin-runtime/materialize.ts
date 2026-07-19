import { type StoredCatalog, validateModelCatalog } from "@aio-proxy/core";
import type { AccountContext, CredentialPort } from "@aio-proxy/plugin-sdk";
import { type Diagnostic, providerLoginCommand } from "@aio-proxy/types";
import {
  OAuthPluginAccountPreparationError,
  type PreparedOAuthPluginAccount,
  prepareOAuthPluginAccount,
} from "../plugin-account";
import { createRuntimeProvider, withRoutingConfig } from "./capabilities";
import {
  catalogDiagnostic,
  catalogFreshness,
  diagnosticState,
  failure,
  pluginVersion,
  refreshDiagnostic,
  summary,
} from "./catalog";
import { digest, runtimeIdentity } from "./identity";
import {
  type CatalogJobDescriptor,
  type MaterializePluginProviderOptions,
  PLUGIN_RUNTIME_TIMEOUT_MS,
  type PluginProviderMaterialization,
} from "./types";

function runtimeDeadline<T>(task: Promise<T>): Promise<T> {
  task.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Plugin runtime creation timed out")), PLUGIN_RUNTIME_TIMEOUT_MS);
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
  const accountOptionsDigest = digest(prepared.accountOptionsIdentity);
  let diagnostics: readonly Diagnostic[];
  try {
    diagnostics = repository.readDiagnostics(config.id);
  } catch {
    return failure(options, "CREDENTIALS_MISSING_OR_INVALID", false, providerLoginCommand(config.id), accountSummary);
  }
  const refreshFailure = refreshDiagnostic(diagnostics);
  if (refreshFailure !== undefined) {
    return {
      summary: summary(config, undefined, accountSummary),
      state: diagnosticState({ ...refreshFailure, suggestedCommand: providerLoginCommand(config.id) }),
    };
  }

  let catalogReadFailed = false;
  let storedCatalog: StoredCatalog | null;
  try {
    storedCatalog = repository.readCatalog(config.id);
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

  const unavailable =
    catalogDiagnostic(diagnostics) ??
    (catalogReadFailed
      ? options.diagnostics("CATALOG_UNAVAILABLE", {
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
  const catalogJobFor = (credentials: CredentialPort<unknown>): CatalogJobDescriptor => ({
    providerId: config.id,
    policy: adapter.catalog.policy,
    stored: storedCatalog,
    ...(unavailable === undefined ? {} : { unavailableOccurredAt: Date.parse(unavailable.occurredAt) }),
    discover: (signal) =>
      adapter.catalog.discover({
        credentials: credentials as never,
        options: accountOptions,
        signal,
      } as unknown as AccountContext<unknown, unknown>),
  });

  if (storedCatalog === null) {
    const diagnostic =
      unavailable ??
      options.diagnostics("CATALOG_UNAVAILABLE", {
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

  const identity = runtimeIdentity({
    packageName: config.plugin,
    version: pluginVersion(plugins, config.plugin),
    capability: config.capability,
    providerId: config.id,
    pluginOptionsDigest: options.pluginOptionsDigest,
    accountOptionsDigest,
    runtimeRevision: account.runtimeRevision,
    catalogDigest: digest(storedCatalog.catalog),
    catalogRefreshedAt: storedCatalog.refreshedAt,
  });
  const state = {
    status: "ready",
    catalog: catalogFreshness(adapter.catalog.policy, storedCatalog, unavailable),
    ...(unavailable === undefined ? {} : { diagnostic: unavailable }),
  } as const;
  if (!config.enabled) {
    const cacheEntry =
      options.previous?.identity === identity
        ? { ...options.previous, provider: withRoutingConfig(options.previous.provider, config) }
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
    const provider = withRoutingConfig(options.previous.provider, config);
    const cacheEntry = { ...options.previous, provider };
    return { provider, summary: persistedSummary(provider, storedCatalog), state, catalogJob, cacheEntry };
  }

  try {
    const result = await runtimeDeadline(
      Promise.resolve().then(() =>
        adapter.createRuntime({
          credentials: credentials as never,
          options: accountOptions,
          catalog: storedCatalog.catalog,
        }),
      ),
    );
    const provider = createRuntimeProvider(config, result, storedCatalog.catalog);
    const cacheEntry = { identity, provider, credentials };
    return { provider, summary: persistedSummary(provider, storedCatalog), state, catalogJob, cacheEntry };
  } catch (error) {
    options.logger({
      event: "plugin.runtime.create.failed",
      code: "RUNTIME_CREATE_FAILED",
      context: { plugin: config.plugin, capability: config.capability, providerId: config.id },
      error: { name: error instanceof Error ? error.name : "Error", message: "Plugin runtime creation failed" },
    });
    return failure(options, "RUNTIME_CREATE_FAILED", true, undefined, accountSummary);
  }
}
