import type {
  OutboundProxy,
  DiagnosticFactory,
  PluginLogSink,
  PluginRegistrySnapshot,
  PluginRepository,
} from '@aio-proxy/core';
import type { CredentialPort, RuntimeFetch } from '@aio-proxy/plugin-sdk';
import type { DashboardProviderSummary, OAuthProvider, ProviderState } from '@aio-proxy/types';

import type { PayloadCaptureHint, RuntimeProviderInstance } from '../runtime';
import type { GuardianEvaluate } from './guardian-evaluation';

export const PLUGIN_RUNTIME_TIMEOUT_MS = 5_000;

export type RuntimeIdentityKey = `sha256:${string}` & { readonly __runtimeIdentity: unique symbol };
export type PluginOptionsIdentityDigest = `sha256:${string}` & {
  readonly __pluginOptionsIdentityDigest: unique symbol;
};

export class PluginRawResolverError extends Error {
  constructor() {
    super('Plugin raw resolver returned an invalid transport');
    this.name = 'PluginRawResolverError';
  }
}

export class PluginRawTransportError extends Error {
  constructor() {
    super('Plugin raw transport returned an invalid response');
    this.name = 'PluginRawTransportError';
  }
}

export type CatalogJobDescriptor = {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly policy: { readonly kind: 'static' } | { readonly kind: 'ttl'; readonly ttlMs: number };
  readonly stored: { readonly refreshedAt: number; readonly revision: number } | null;
  readonly unavailableOccurredAt?: number;
  /** Discovers and returns the synchronous commit for that result. Throws on discovery failure. */
  readonly discover: (signal: AbortSignal) => Promise<CatalogCommit>;
  /** Records a failed discovery. Returns true when stored state changed and the snapshot must rebuild. */
  readonly markUnavailable: (error: unknown) => boolean;
};
/** Returns false when the write was fenced off. */
export type CatalogCommit = () => boolean;

export type PluginRuntimeCacheEntry = {
  readonly payloadCaptureHint?: PayloadCaptureHint;
  readonly identity: RuntimeIdentityKey;
  readonly provider: RuntimeProviderInstance;
  readonly credentials: CredentialPort<unknown>;
  readonly fetch: RuntimeFetch;
};

export type PluginProviderMaterialization = {
  readonly payloadCaptureHint?: PayloadCaptureHint;
  readonly provider?: RuntimeProviderInstance;
  readonly summary: Omit<DashboardProviderSummary, 'state'>;
  readonly state: ProviderState;
  readonly catalogJob?: CatalogJobDescriptor;
  readonly cacheEntry?: PluginRuntimeCacheEntry;
};

export type MaterializePluginProviderOptions = {
  readonly guardianEvaluate?: (source: { readonly providerId?: string; readonly plugin?: string }) => GuardianEvaluate;
  readonly config: OAuthProvider;
  readonly plugins: PluginRegistrySnapshot;
  readonly repository: PluginRepository;
  readonly diagnostics: DiagnosticFactory;
  readonly logger: PluginLogSink;
  readonly onDiagnosticChanged: () => void;
  readonly pluginOptionsDigest: PluginOptionsIdentityDigest;
  readonly effectiveProxy?: OutboundProxy | null;
  readonly runtimeFetch?: RuntimeFetch;
  readonly pluginSecrets?: unknown;
  readonly previous?: PluginRuntimeCacheEntry;
};
