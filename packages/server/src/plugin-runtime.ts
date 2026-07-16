import { createHash } from "node:crypto";
import {
  createCredentialPort,
  createProviderV4Invoke,
  type DiagnosticFactory,
  modelRoutes,
  type PluginLogSink,
  type PluginRegistrySnapshot,
  type PluginRepository,
  PluginSchemaContractError,
  parsePluginSchema,
  type StoredCatalog,
  validateConfigSpec,
  validateModelCatalog,
  validateProviderV4,
} from "@aio-proxy/core";
import type {
  AccountContext,
  CredentialPort,
  ModelCatalog,
  OAuthAdapter,
  ProtocolId,
  RawResolver,
} from "@aio-proxy/plugin-sdk";
import {
  type DashboardProviderSummary,
  type Diagnostic,
  type OAuthProvider,
  ProviderKind,
  type ProviderProtocol,
  type ProviderState,
  providerLoginCommand,
} from "@aio-proxy/types";
import type { RuntimeProviderInstance } from "./runtime";

export const PLUGIN_RUNTIME_TIMEOUT_MS = 5_000;

export type RuntimeIdentityKey = `sha256:${string}` & { readonly __runtimeIdentity: unique symbol };
export type PluginOptionsIdentityDigest = `sha256:${string}` & {
  readonly __pluginOptionsIdentityDigest: unique symbol;
};

export class PluginRawResolverError extends Error {
  constructor() {
    super("Plugin raw resolver returned an invalid transport");
    this.name = "PluginRawResolverError";
  }
}

export class PluginRawTransportError extends Error {
  constructor() {
    super("Plugin raw transport returned an invalid response");
    this.name = "PluginRawTransportError";
  }
}

export type CatalogJobDescriptor = {
  readonly providerId: string;
  readonly policy: OAuthAdapter["catalog"]["policy"];
  readonly discover: (signal: AbortSignal) => Promise<ModelCatalog>;
  readonly stored: StoredCatalog | null;
  readonly unavailableOccurredAt?: number;
};

export type PluginRuntimeCacheEntry = {
  readonly identity: RuntimeIdentityKey;
  readonly provider: RuntimeProviderInstance;
  readonly credentials: CredentialPort<unknown>;
};

export type PluginProviderMaterialization = {
  readonly provider?: RuntimeProviderInstance;
  readonly summary: Omit<DashboardProviderSummary, "state">;
  readonly state: ProviderState;
  readonly catalogJob?: CatalogJobDescriptor;
  readonly cacheEntry?: PluginRuntimeCacheEntry;
};

export type MaterializePluginProviderOptions = {
  readonly config: OAuthProvider;
  readonly plugins: PluginRegistrySnapshot;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
  readonly pluginOptionsDigest: PluginOptionsIdentityDigest;
  readonly pluginSecrets?: unknown;
  readonly previous?: PluginRuntimeCacheEntry;
};

const pluginProtocol = {
  "openai-compatible": "openai-compatible",
  "openai-response": "openai-response",
  anthropic: "anthropic",
  gemini: "gemini",
} as const satisfies Record<ProviderProtocol, ProtocolId>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stable(value: unknown, seen = new Set<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("Cannot hash cyclic plugin data");
  seen.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => stable(item, seen))
    : Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, stable(item, seen)]),
      );
  seen.delete(value);
  return result;
}

function digest(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex")}`;
}

export function pluginOptionsIdentityDigest(value: {
  readonly public: unknown;
  readonly secret: unknown;
}): PluginOptionsIdentityDigest {
  return digest(value) as PluginOptionsIdentityDigest;
}

function runtimeIdentity(value: unknown): RuntimeIdentityKey {
  return digest(value) as RuntimeIdentityKey;
}

function diagnosticState(diagnostic: Diagnostic): ProviderState {
  return { status: "unavailable", diagnostic };
}

function summary(
  config: OAuthProvider,
  provider: RuntimeProviderInstance | undefined,
  persisted?: {
    readonly accountLabel?: string;
    readonly expiresAt?: number;
    readonly catalogLastSuccessAt?: string;
  },
): Omit<DashboardProviderSummary, "state"> {
  return {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    passthrough: provider?.raw !== undefined,
    last_status: "unknown",
    last_latency: null,
    name: config.name,
    clientModels: provider === undefined ? [] : [...new Set(modelRoutes(provider).map((route) => route.alias))],
    plugin: config.plugin,
    capability: config.capability,
    ...(persisted?.accountLabel === undefined ? {} : { accountLabel: persisted.accountLabel }),
    ...(persisted?.expiresAt === undefined ? {} : { expiresAt: persisted.expiresAt }),
    ...(persisted?.catalogLastSuccessAt === undefined ? {} : { catalogLastSuccessAt: persisted.catalogLastSuccessAt }),
  };
}

function failure(
  options: MaterializePluginProviderOptions,
  code: Parameters<DiagnosticFactory>[0],
  retryable: boolean,
  suggestedCommand?: string,
  persisted?: Parameters<typeof summary>[2],
): PluginProviderMaterialization {
  const diagnostic = options.diagnostics(code, {
    plugin: options.config.plugin,
    capability: options.config.capability,
    providerId: options.config.id,
    retryable,
    ...(suggestedCommand === undefined ? {} : { suggestedCommand }),
  });
  return { summary: summary(options.config, undefined, persisted), state: diagnosticState(diagnostic) };
}

function pluginVersion(plugins: PluginRegistrySnapshot, packageName: string): string | undefined {
  return plugins.plugins.get(packageName)?.version;
}

function catalogDiagnostic(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  return diagnostics.find((item) => item.code === "CATALOG_UNAVAILABLE");
}

function refreshDiagnostic(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  return diagnostics.find((item) => item.code === "CREDENTIAL_REFRESH_FAILED");
}

function catalogFreshness(
  policy: OAuthAdapter["catalog"]["policy"],
  stored: StoredCatalog,
  unavailable: Diagnostic | undefined,
): "fresh" | "stale" {
  if (unavailable !== undefined) return "stale";
  return policy.kind === "ttl" && stored.refreshedAt + policy.ttlMs <= Date.now() ? "stale" : "fresh";
}

function rawCapability(rawResolver: RawResolver | undefined, catalog: ModelCatalog) {
  if (rawResolver === undefined) return undefined;
  const languageCatalogById = new Map(catalog.language.map((descriptor) => [descriptor.id, descriptor]));
  return {
    resolve({ protocol, modelId }: { readonly protocol: ProviderProtocol; readonly modelId: string }) {
      const descriptor = languageCatalogById.get(modelId);
      const transport = rawResolver({
        protocol: pluginProtocol[protocol],
        modelId,
        ...(descriptor?.metadata === undefined ? {} : { metadata: descriptor.metadata }),
      });
      if (transport === undefined) return undefined;
      if (!isRecord(transport) || typeof transport.invoke !== "function") throw new PluginRawResolverError();
      return {
        async invoke(request: Request): Promise<Response> {
          const response = await transport.invoke(request);
          if (!(response instanceof Response)) throw new PluginRawTransportError();
          return response;
        },
      };
    },
  };
}

function metadata(catalog: ModelCatalog): Readonly<Record<string, { readonly displayName?: string }>> {
  return Object.fromEntries(
    catalog.language.map((descriptor) => [
      descriptor.id,
      descriptor.displayName === undefined ? {} : { displayName: descriptor.displayName },
    ]),
  );
}

function withRoutingConfig(provider: RuntimeProviderInstance, config: OAuthProvider): RuntimeProviderInstance {
  const { alias: _previousAlias, ...previousProvider } = provider;
  return {
    ...previousProvider,
    enabled: config.enabled,
    ...(config.alias === undefined ? {} : { alias: config.alias }),
  };
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
  let account: ReturnType<PluginRepository["readAccount"]>;
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
    const preTransformDigest = digest({ public: publicOptions, secret: account.secrets });
    const parsed = await parsePluginSchema(adapter.account.options.schema, { ...publicOptions, ...account.secrets });
    if (!parsed.ok) throw new Error("Invalid account options");
    accountOptions = parsed.value;
    accountOptionsDigest = preTransformDigest;
  } catch {
    return failure(options, "ACCOUNT_OPTIONS_INVALID", false, providerLoginCommand(config.id), accountSummary);
  }

  let parsedCredential: Awaited<ReturnType<typeof parsePluginSchema>>;
  try {
    parsedCredential = await parsePluginSchema(adapter.credentials, account.credential);
  } catch (error) {
    if (error instanceof PluginSchemaContractError) {
      return failure(options, "PLUGIN_LOAD_FAILED", false, undefined, accountSummary);
    }
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
  const persistedSummary = (provider: RuntimeProviderInstance | undefined, catalog: StoredCatalog | null) =>
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
  if (!config.enabled) {
    const cacheEntry =
      options.previous?.identity === identity
        ? { ...options.previous, provider: withRoutingConfig(options.previous.provider, config) }
        : undefined;
    const state = {
      status: "ready",
      catalog: catalogFreshness(adapter.catalog.policy, storedCatalog, unavailable),
      ...(unavailable === undefined ? {} : { diagnostic: unavailable }),
    } as const;
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
    const state = {
      status: "ready",
      catalog: catalogFreshness(adapter.catalog.policy, storedCatalog, unavailable),
      ...(unavailable === undefined ? {} : { diagnostic: unavailable }),
    } as const;
    return {
      provider,
      summary: persistedSummary(provider, storedCatalog),
      state,
      catalogJob,
      cacheEntry,
    };
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
    if (!isRecord(result) || !validateProviderV4(result.provider)) throw new Error("Invalid ProviderV4 runtime");
    if (result.raw !== undefined && typeof result.raw !== "function") throw new PluginRawResolverError();
    const raw = result.raw === undefined ? undefined : rawCapability(result.raw, storedCatalog.catalog);
    const provider: RuntimeProviderInstance = {
      id: config.id,
      kind: ProviderKind.OAuth,
      enabled: config.enabled,
      models: storedCatalog.catalog.language.map(({ id }) => id),
      ...(config.alias === undefined ? {} : { alias: config.alias }),
      modelMetadata: metadata(storedCatalog.catalog),
      plugin: config.plugin,
      capability: config.capability,
      ...(raw === undefined ? {} : { raw }),
      model: { invoke: createProviderV4Invoke(config.id, result.provider) },
    };
    const cacheEntry = { identity, provider, credentials };
    const state = {
      status: "ready",
      catalog: catalogFreshness(adapter.catalog.policy, storedCatalog, unavailable),
      ...(unavailable === undefined ? {} : { diagnostic: unavailable }),
    } as const;
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

export function validatePluginProtocolMap(): Readonly<Record<ProviderProtocol, ProtocolId>> {
  return pluginProtocol;
}
