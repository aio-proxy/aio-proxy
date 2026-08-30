import {
  createProviderV4Embed,
  createProviderV4ImageInvoke,
  createProviderV4Invoke,
  validateProviderV4,
} from '@aio-proxy/core';
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
import { isObject } from '@aio-proxy/shared';
import {
  aliasTargetModels,
  type OAuthProvider,
  preservedAliasModels,
  ProviderKind,
  ProviderProtocol,
} from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

import { buildModelCapabilityIndex } from '../provider-runtime/capability-index';
import type { RawResolveInput, RuntimeProviderInstance } from '../runtime';
import { modelMetadataRecord } from './catalog';
import { PluginRawResolverError, PluginRawTransportError } from './types';

export const pluginProtocol = {
  'openai-compatible': 'openai-compatible',
  'openai-response': 'openai-response',
  anthropic: 'anthropic',
  gemini: 'gemini',
  'gemini-interactions': 'gemini-interactions',
  'openai-image': 'openai-image',
} as const satisfies Record<ProviderProtocol, ProtocolId>;

export function catalogModelIds(catalog: Pick<ModelCatalog, 'language' | 'image' | 'embedding'>): string[] {
  return uniq([
    ...catalog.language.map(({ id }) => id),
    ...catalog.image.map(({ id }) => id),
    ...catalog.embedding.map(({ id }) => id),
  ]);
}

function rawCapability(rawResolver: RawResolver | undefined, catalog: ModelCatalog) {
  if (rawResolver === undefined) return undefined;
  const languageCatalogById = new Map(catalog.language.map((descriptor) => [descriptor.id, descriptor]));
  const imageCatalogById = new Map(catalog.image.map((descriptor) => [descriptor.id, descriptor]));
  const embeddingCatalogById = new Map(catalog.embedding.map((descriptor) => [descriptor.id, descriptor]));
  return {
    resolve({ protocol, modelId, capability, requestPath }: RawResolveInput) {
      const descriptor =
        capability === 'embedding'
          ? (embeddingCatalogById.get(modelId) ?? languageCatalogById.get(modelId) ?? imageCatalogById.get(modelId))
          : protocol === ProviderProtocol.OpenAIImage
            ? (imageCatalogById.get(modelId) ?? languageCatalogById.get(modelId) ?? embeddingCatalogById.get(modelId))
            : (languageCatalogById.get(modelId) ?? imageCatalogById.get(modelId) ?? embeddingCatalogById.get(modelId));
      const transport = rawResolver({
        protocol: pluginProtocol[protocol],
        modelId,
        ...(descriptor?.extra === undefined ? {} : { extra: descriptor.extra }),
        ...(capability === undefined ? {} : { capability }),
        ...(requestPath === undefined ? {} : { requestPath }),
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
  catalog: ModelCatalog,
): RuntimeProviderInstance {
  const {
    alias: _previousAlias,
    priority: _previousPriority,
    weight: _previousWeight,
    capabilityIndex: _previousCapabilityIndex,
    upstreamMetadata: _previousUpstreamMetadata,
    ...previousProvider
  } = provider;
  const models = exposedModelIds(catalogModelIds(catalog), config.models);
  const { capabilityIndex, upstreamMetadata } = routingCapabilities(config, catalog, models);
  return {
    ...previousProvider,
    enabled: config.enabled,
    ...routingDefaults(config),
    models,
    capabilityIndex,
    upstreamMetadata,
    ...(config.alias === undefined ? {} : { alias: config.alias }),
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
  const models = exposedModelIds(catalogModelIds(catalog), config.models);
  const { capabilityIndex, upstreamMetadata } = routingCapabilities(config, catalog, models);
  const image =
    catalog.image.length > 0 ? { invoke: createProviderV4ImageInvoke(config.id, result.provider) } : undefined;
  const embedding =
    catalog.embedding.length > 0 ? { embed: createProviderV4Embed(config.id, result.provider) } : undefined;
  const base = {
    id: config.id,
    kind: ProviderKind.OAuth,
    enabled: config.enabled,
    ...routingDefaults(config),
    models,
    capabilityIndex,
    ...(config.alias === undefined ? {} : { alias: config.alias }),
    upstreamMetadata,
    plugin: config.plugin,
    capability: config.capability,
    ...(tokenCount === undefined ? {} : { tokenCount }),
  };
  if (catalog.language.length > 0) {
    return {
      ...base,
      ...(raw === undefined ? {} : { raw }),
      // Router metadata may grant image output to language-catalog models at
      // request time, so the invoke attaches unconditionally. It is lazy: a V4
      // provider without imageModel fails per-attempt like any candidate
      // failure.
      image: { invoke: createProviderV4ImageInvoke(config.id, result.provider) },
      ...(embedding === undefined ? {} : { embedding }),
      model: {
        invoke: createProviderV4Invoke(config.id, result.provider),
        supportsProviderTool: (type) => supportedProviderTools.has(type),
        targetProtocol: (modelId) => upstreamMetadata[modelId]?.protocol,
      },
    };
  }
  if (image !== undefined) {
    return {
      ...base,
      image,
      ...(embedding === undefined ? {} : { embedding }),
      ...(raw === undefined ? {} : { raw }),
    };
  }
  if (embedding !== undefined) {
    return { ...base, embedding, ...(raw === undefined ? {} : { raw }) };
  }
  if (raw !== undefined) {
    return { ...base, raw };
  }
  throw new Error('Invalid ProviderV4 runtime');
}

function routingCapabilities(
  config: OAuthProvider,
  catalog: ModelCatalog,
  models: readonly string[],
): {
  readonly capabilityIndex: ReturnType<typeof buildModelCapabilityIndex>;
  readonly upstreamMetadata: ReturnType<typeof modelMetadataRecord>;
} {
  const allowed = new Set([...models, ...(config.alias === undefined ? [] : preservedAliasModels(config.alias))]);
  const upstreamMetadata = filterAllowedRecord(modelMetadataRecord(catalog), allowed) ?? {};
  return {
    capabilityIndex: buildModelCapabilityIndex({
      catalog,
      models,
      upstreamMetadata,
      aliasTargets:
        config.alias === undefined ? undefined : uniq(Object.values(config.alias).flatMap(aliasTargetModels)),
    }),
    upstreamMetadata,
  };
}

function filterAllowedRecord<T>(
  record: Readonly<Record<string, T>> | undefined,
  allowed: ReadonlySet<string>,
): Record<string, T> | undefined {
  if (record === undefined) return undefined;
  return Object.fromEntries(Object.entries(record).filter(([id]) => allowed.has(id)));
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
  if (!isObject(value)) {
    throw new Error('Invalid token count capability');
  }
  const countTokens = Reflect.get(value, 'countTokens');
  if (typeof countTokens !== 'function') throw new Error('Invalid token count capability');
  return { countTokens: (input) => countTokens.call(value, input) };
}

const providerToolTypes: ReadonlySet<ProviderExecutedTool['type']> = new Set(['web-search']);

function providerToolCapability(value: unknown): ProviderToolCapability | undefined {
  if (value === undefined) return undefined;
  if (!isObject(value)) {
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
