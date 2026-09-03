import { type DiagnosticFactory, modelRoutes, type PluginRegistrySnapshot, type StoredCatalog } from '@aio-proxy/core';
import type { ModelCatalog, OAuthAdapter } from '@aio-proxy/plugin-sdk';
import {
  type DashboardProviderSummary,
  type Diagnostic,
  type OAuthProvider,
  ProviderKind,
  ProviderProtocol,
  type ProviderState,
} from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';
import { isPlainObject } from 'es-toolkit/predicate';

import type { RuntimeModelMetadata, RuntimeProviderInstance } from '../runtime';
import type { MaterializePluginProviderOptions, PluginProviderMaterialization } from './types';

export function diagnosticState(diagnostic: Diagnostic): ProviderState {
  return { status: 'unavailable', diagnostic };
}

export function summary(
  config: OAuthProvider,
  provider: RuntimeProviderInstance | undefined,
  persisted?: {
    readonly accountLabel?: string;
    readonly expiresAt?: number;
    readonly catalogLastSuccessAt?: string;
  },
  hasQuota = false,
  canRefreshCredential = false,
): Omit<DashboardProviderSummary, 'state'> {
  return {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    passthrough: provider?.raw !== undefined,
    last_status: 'unknown',
    last_latency: null,
    name: config.name,
    // OAuth providers speak whatever their plugin runtime speaks; there is no configured wire protocol.
    protocols: [],
    hasQuota,
    canRefreshCredential,
    ...(config.priority === undefined ? {} : { priority: config.priority }),
    ...(config.weight === undefined ? {} : { weight: config.weight }),
    clientModels: provider === undefined ? [] : uniq(modelRoutes(provider).map((route) => route.alias)),
    plugin: config.plugin,
    capability: config.capability,
    ...(persisted?.accountLabel === undefined ? {} : { accountLabel: persisted.accountLabel }),
    ...(persisted?.expiresAt === undefined ? {} : { expiresAt: persisted.expiresAt }),
    ...(persisted?.catalogLastSuccessAt === undefined ? {} : { catalogLastSuccessAt: persisted.catalogLastSuccessAt }),
  };
}

export function failure(
  options: MaterializePluginProviderOptions,
  code: Parameters<DiagnosticFactory>[0],
  retryable: boolean,
  suggestedCommand?: string,
  persisted?: Parameters<typeof summary>[2],
  // Quota lives on the adapter, not the runtime: a provider whose runtime or proxy check failed can
  // still answer a quota read, so an unavailable card must keep showing its ring.
  hasQuota = false,
  // Refresh lives on the adapter, not the runtime: the menu item that repairs a broken credential
  // must still be reachable on an unavailable card.
  canRefreshCredential = false,
): PluginProviderMaterialization {
  const diagnostic = options.diagnostics(code, {
    plugin: options.config.plugin,
    capability: options.config.capability,
    providerId: options.config.id,
    retryable,
    ...(suggestedCommand === undefined ? {} : { suggestedCommand }),
  });
  return {
    summary: summary(options.config, undefined, persisted, hasQuota, canRefreshCredential),
    state: diagnosticState(diagnostic),
  };
}

export function pluginVersion(plugins: PluginRegistrySnapshot, packageName: string): string | undefined {
  return plugins.plugins.get(packageName)?.version;
}

export function catalogDiagnostic(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  return diagnostics.find((item) => item.code === 'CATALOG_UNAVAILABLE');
}

export function refreshDiagnostic(diagnostics: readonly Diagnostic[]): Diagnostic | undefined {
  return diagnostics.find((item) => item.code === 'CREDENTIAL_REFRESH_FAILED');
}

export function catalogFreshness(
  policy: OAuthAdapter['catalog']['policy'],
  stored: StoredCatalog,
  unavailable: Diagnostic | undefined,
): 'fresh' | 'stale' {
  if (unavailable !== undefined) return 'stale';
  if (policy.kind === 'ttl' && stored.revision === 0) return 'stale';
  return policy.kind === 'ttl' && stored.refreshedAt + policy.ttlMs <= Date.now() ? 'stale' : 'fresh';
}

export function modelMetadataRecord(catalog: ModelCatalog): Readonly<Record<string, RuntimeModelMetadata>> {
  const record: Record<string, RuntimeModelMetadata> = {};
  for (const descriptor of [...catalog.embedding, ...catalog.image]) {
    const next = descriptorMetadata(descriptor);
    const existing = record[descriptor.id];
    // Cross-modality overlap merges fields; the earlier modality wins conflicts
    // (embedding before image — this loop's order).
    record[descriptor.id] = existing === undefined ? next : { ...next, ...existing };
  }
  for (const descriptor of catalog.language) {
    const next = descriptorMetadata(descriptor);
    const existing = record[descriptor.id];
    if (existing === undefined) {
      record[descriptor.id] = next;
      continue;
    }
    // Language owns targetProtocol: a protocol from a non-language descriptor's
    // extra must not survive (image/embed convert never read it, and it must not
    // redirect language dispatch). Other fields merge; language wins conflicts.
    const { protocol: _nonLanguageProtocol, ...nonLanguageFields } = existing;
    record[descriptor.id] = { ...nonLanguageFields, ...next };
  }
  return record;
}

function descriptorMetadata(descriptor: ModelCatalog['language'][number]): RuntimeModelMetadata {
  const protocol = metadataProtocol(descriptor.extra);
  const typed = descriptor.modelMetadata ?? {};
  return {
    ...typed,
    ...(descriptor.displayName === undefined ? {} : { name: descriptor.displayName }),
    ...(protocol === undefined ? {} : { protocol }),
  };
}

function metadataProtocol(metadata: unknown): ProviderProtocol | undefined {
  if (!isPlainObject(metadata)) return undefined;
  const protocol = Reflect.get(metadata, 'protocol');
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
    case ProviderProtocol.OpenAIResponse:
    case ProviderProtocol.Anthropic:
    case ProviderProtocol.Gemini:
    case ProviderProtocol.GeminiInteractions:
    case ProviderProtocol.OpenAIImage:
      return protocol;
    default:
      return undefined;
  }
}
