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
): Omit<DashboardProviderSummary, 'state'> {
  return {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    passthrough: provider?.raw !== undefined,
    last_status: 'unknown',
    last_latency: null,
    name: config.name,
    ...(config.priority === undefined ? {} : { priority: config.priority }),
    ...(config.weight === undefined ? {} : { weight: config.weight }),
    clientModels: provider === undefined ? [] : [...new Set(modelRoutes(provider).map((route) => route.alias))],
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
    record[descriptor.id] = descriptorMetadata(descriptor);
  }
  for (const descriptor of catalog.language) {
    const next = descriptorMetadata(descriptor);
    const existing = record[descriptor.id];
    if (existing === undefined) {
      record[descriptor.id] = next;
      continue;
    }
    // Language owns targetProtocol. Image/embed convert do not read this record
    // for dispatch, so an overlapping non-language descriptor must not replace
    // or invent a protocol.
    record[descriptor.id] = {
      ...(existing.name === undefined ? {} : { name: existing.name }),
      ...(next.name === undefined ? {} : { name: next.name }),
      ...(next.protocol === undefined ? {} : { protocol: next.protocol }),
    };
  }
  return record;
}

function descriptorMetadata(descriptor: ModelCatalog['language'][number]): RuntimeModelMetadata {
  const protocol = metadataProtocol(descriptor.metadata);
  return {
    ...(descriptor.displayName === undefined ? {} : { name: descriptor.displayName }),
    ...(protocol === undefined ? {} : { protocol }),
  };
}

function metadataProtocol(metadata: unknown): ProviderProtocol | undefined {
  if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) return undefined;
  const protocol = Reflect.get(metadata, 'protocol');
  switch (protocol) {
    case ProviderProtocol.OpenAICompatible:
    case ProviderProtocol.OpenAIResponse:
    case ProviderProtocol.Anthropic:
    case ProviderProtocol.Gemini:
    case ProviderProtocol.OpenAIImage:
      return protocol;
    default:
      return undefined;
  }
}
