import type {
  DiagnosticFactory,
  PluginLogSink,
  PluginRegistrySnapshot,
  PluginRepository,
  StoredCatalog,
} from "@aio-proxy/core";
import type { CredentialPort, ModelCatalog, OAuthAdapter } from "@aio-proxy/plugin-sdk";
import type { DashboardProviderSummary, OAuthProvider, ProviderState } from "@aio-proxy/types";
import type { RuntimeProviderInstance } from "../runtime";

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
