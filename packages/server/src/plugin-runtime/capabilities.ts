import { createProviderV4Invoke, validateProviderV4 } from '@aio-proxy/core';
import type {
  LogicalRequestContext,
  ModelCatalog,
  ProtocolId,
  ProviderExecutedTool,
  ProviderToolCapability,
  RawResolver,
  RawTransportOptions,
  TokenCountCapability,
} from '@aio-proxy/plugin-sdk';
import { type OAuthProvider, ProviderKind, type ProviderProtocol } from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

import { buildModelCapabilityIndex } from '../provider-runtime/capability-index';
import type { RuntimeProviderInstance } from '../runtime';
import { modelMetadataRecord } from './catalog';
import { PluginRawResolverError, PluginRawTransportError } from './types';

export const pluginProtocol = {
  'openai-compatible': 'openai-compatible',
  'openai-response': 'openai-response',
  anthropic: 'anthropic',
  gemini: 'gemini',
  'openai-image': 'openai-image',
} as const satisfies Record<ProviderProtocol, ProtocolId>;

export function catalogModelIds(catalog: Pick<ModelCatalog, 'language' | 'image'>): string[] {
  return uniq([...catalog.language.map(({ id }) => id), ...catalog.image.map(({ id }) => id)]);
}

function rawCapability(rawResolver: RawResolver | undefined, catalog: ModelCatalog) {
  if (rawResolver === undefined) return undefined;
  const languageCatalogById = new Map(catalog.language.map((descriptor) => [descriptor.id, descriptor]));
  const imageCatalogById = new Map(catalog.image.map((descriptor) => [descriptor.id, descriptor]));
  return {
    resolve({ protocol, modelId }: { readonly protocol: ProviderProtocol; readonly modelId: string }) {
      const descriptor = imageCatalogById.get(modelId) ?? languageCatalogById.get(modelId);
      const transport = rawResolver({
        protocol: pluginProtocol[protocol],
        modelId,
        ...(descriptor?.metadata === undefined ? {} : { metadata: descriptor.metadata }),
      });
      if (transport === undefined) return undefined;
      if (
        typeof transport !== 'object' ||
        transport === null ||
        Array.isArray(transport) ||
        typeof transport.invoke !== 'function'
      ) {
        throw new PluginRawResolverError();
      }
      return {
        async invoke(
          request: Request,
          context?: LogicalRequestContext,
          options?: RawTransportOptions,
        ): Promise<Response> {
          const response = await transport.invoke(request, context, options);
          if (!(response instanceof Response)) throw new PluginRawTransportError();
          return response;
        },
      };
    },
  };
}

// One rule, two call sites (fresh + cached). Absent or empty whitelist means
// expose everything so existing oauth configs keep working; stale whitelist
// entries are dropped so they cannot create dead routes.
export function exposedModelIds(catalogIds: readonly string[], whitelist: readonly string[] | undefined): string[] {
  if (whitelist === undefined || whitelist.length === 0) return [...catalogIds];
  const allowed = new Set(whitelist);
  return catalogIds.filter((id) => allowed.has(id));
}

export function withRoutingConfig(
  provider: RuntimeProviderInstance,
  config: OAuthProvider,
  catalogIds: readonly string[],
): RuntimeProviderInstance {
  const {
    alias: _previousAlias,
    configMetadata: _previousConfigMetadata,
    priority: _previousPriority,
    weight: _previousWeight,
    ...previousProvider
  } = provider;
  return {
    ...previousProvider,
    enabled: config.enabled,
    ...routingDefaults(config),
    models: exposedModelIds(catalogIds, config.models),
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    ...(config.metadata === undefined ? {} : { configMetadata: config.metadata }),
  };
}

export function createRuntimeProvider(
  config: OAuthProvider,
  result: unknown,
  catalog: ModelCatalog,
): RuntimeProviderInstance {
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result) ||
    !('provider' in result) ||
    !validateProviderV4(result.provider)
  ) {
    throw new Error('Invalid ProviderV4 runtime');
  }
  if ('raw' in result && result.raw !== undefined && typeof result.raw !== 'function') {
    throw new PluginRawResolverError();
  }
  const raw =
    'raw' in result && typeof result.raw === 'function' ? rawCapability(result.raw as RawResolver, catalog) : undefined;
  const providerTools = providerToolCapability(Reflect.get(result, 'providerTools'));
  const supportedProviderTools = new Set(providerTools?.supported);
  const tokenCount = tokenCountCapability(Reflect.get(result, 'tokenCount'));
  const upstreamMetadata = modelMetadataRecord(catalog);
  const models = exposedModelIds(catalogModelIds(catalog), config.models);
  const capabilityIndex = buildModelCapabilityIndex({
    catalog,
    models,
    metadata: config.metadata,
    configMetadata: config.metadata,
    upstreamMetadata,
  });
  const base = {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    ...routingDefaults(config),
    models,
    capabilityIndex,
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    ...(config.metadata === undefined ? {} : { configMetadata: config.metadata }),
    upstreamMetadata,
    plugin: config.plugin,
    capability: config.capability,
    ...(tokenCount === undefined ? {} : { tokenCount }),
  };
  if (catalog.language.length > 0) {
    return {
      ...base,
      ...(raw === undefined ? {} : { raw }),
      model: {
        invoke: createProviderV4Invoke(config.id, result.provider),
        supportsProviderTool: (type) => supportedProviderTools.has(type),
        targetProtocol: (modelId) => upstreamMetadata[modelId]?.protocol,
      },
    };
  }
  if (raw !== undefined) {
    return { ...base, raw };
  }
  throw new Error('Invalid ProviderV4 runtime');
}

function routingDefaults(config: { readonly priority?: number; readonly weight?: number }): {
  readonly priority?: number;
  readonly weight?: number;
} {
  return {
    ...(config.priority === undefined ? {} : { priority: config.priority }),
    ...(config.weight === undefined ? {} : { weight: config.weight }),
  };
}

function tokenCountCapability(value: unknown): TokenCountCapability | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid token count capability');
  }
  const countTokens = Reflect.get(value, 'countTokens');
  if (typeof countTokens !== 'function') throw new Error('Invalid token count capability');
  return { countTokens: (input) => countTokens.call(value, input) };
}

const providerToolTypes: ReadonlySet<ProviderExecutedTool['type']> = new Set(['web-search']);

function providerToolCapability(value: unknown): ProviderToolCapability | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid provider tool capability');
  }
  const supported = Reflect.get(value, 'supported');
  if (
    !Array.isArray(supported) ||
    !supported.every((type) => providerToolTypes.has(type as ProviderExecutedTool['type']))
  ) {
    throw new Error('Invalid provider tool capability');
  }
  return { supported } as ProviderToolCapability;
}
