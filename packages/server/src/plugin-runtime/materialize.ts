import {
  createCredentialPort,
  PluginSchemaContractError,
  parsePluginSchema,
  type StoredCatalog,
  validateConfigSpec,
  validateModelCatalog,
} from "@aio-proxy/core";
import type { AccountContext, CredentialPort } from "@aio-proxy/plugin-sdk";
import { type Diagnostic, providerLoginCommand } from "@aio-proxy/types";
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  const loaded = plugins.plugins.get(config.plugin);
  if (loaded === undefined || loaded.state.status === "failed") {
    return failure(
      options,
      loaded?.state.status === "failed" ? loaded.state.diagnostic.code : "PLUGIN_NOT_INSTALLED",
      false,
    );
  }
  const adapter = plugins.registry.resolveOAuth(config.plugin, config.capability);
  if (adapter === undefined) return failure(options, "CAPABILITY_MISSING", false);
  let account: ReturnType<typeof repository.readAccount>;
  try {
    account = repository.readAccount(config.id);
  } catch {
    return failure(options, "CREDENTIALS_MISSING_OR_INVALID", false, providerLoginCommand(config.id));
  }
  if (account === null || account.plugin !== config.plugin || account.capability !== config.capability) {
    return failure(options, "CREDENTIALS_MISSING_OR_INVALID", false);
  }
  const accountSummary = {
    ...(account.label === undefined ? {} : { accountLabel: account.label }),
    ...(account.expiresAt === undefined ? {} : { expiresAt: account.expiresAt }),
  };

  let accountOptions: unknown;
  let accountOptionsDigest: `sha256:${string}`;
  try {
    const { secretKeys } = validateConfigSpec(adapter.account.options);
    const publicOptions = config.options ?? {};
    if (!isRecord(publicOptions) || !isRecord(account.secrets)) throw new Error("Invalid account options");
    for (const key of secretKeys) if (Object.hasOwn(publicOptions, key)) throw new Error("Secret option in config");
    accountOptionsDigest = digest({ public: publicOptions, secret: account.secrets });
    const parsed = await parsePluginSchema(adapter.account.options.schema, { ...publicOptions, ...account.secrets });
    if (!parsed.ok) throw new Error("Invalid account options");
    accountOptions = parsed.value;
  } catch {
    return failure(options, "ACCOUNT_OPTIONS_INVALID", false, providerLoginCommand(config.id), accountSummary);
  }

  let parsedCredential: Awaited<ReturnType<typeof parsePluginSchema>>;
  try {
    parsedCredential = await parsePluginSchema(adapter.credentials, account.credential);
  } catch (error) {
    if (error instanceof PluginSchemaContractError)
      return failure(options, "PLUGIN_LOAD_FAILED", false, undefined, accountSummary);
    throw error;
  }
  if (!parsedCredential.ok) {
    return failure(options, "CREDENTIALS_MISSING_OR_INVALID", false, providerLoginCommand(config.id), accountSummary);
  }
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
  const createCredentials = (): CredentialPort<unknown> =>
    createCredentialPort({
      providerId: config.id,
      schema: adapter.credentials,
      repository,
      diagnostics: options.diagnostics,
      logger: options.logger,
      onDiagnosticChanged: options.onDiagnosticChanged,
      onCredentialChanged: options.onDiagnosticChanged,
      pluginSecrets: options.pluginSecrets,
    }) as CredentialPort<unknown>;
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
