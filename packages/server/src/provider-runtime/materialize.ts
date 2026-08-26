import {
  type AiSdkProviderInstance,
  bridgeApiProviderToAiSdk,
  createAiSdkProvider,
  createApiProvider,
  createProxyFetch,
  modelRoutes,
} from '@aio-proxy/core';
import type { AliasConfig, Config, DashboardProviderSummary, ModelMetadata, Provider } from '@aio-proxy/types';
import { aliasTargetModels, apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';

import { createProviderRequestTransformFetch } from '../provider-request-transform';
import { createObservedFetch } from '../request-logging';
import type {
  EmbeddingTransport,
  ImageTransport,
  ModelCapabilityIndex,
  ModelTransport,
  RuntimeProviderInput,
  RuntimeProviderInstance,
  RuntimeRawCapability,
} from '../runtime';
import { buildModelCapabilityIndex } from './capability-index';
import { attachImageTransport } from './materialize-image';
import { probeAiSdk, probeApi, type ProviderProbe } from './probe';

export type MaterializeProvidersOptions = {
  readonly bridgeApiProvider?: typeof bridgeApiProviderToAiSdk;
  readonly createApiProvider?: typeof createApiProvider;
  readonly createAiSdkProvider?: typeof createAiSdkProvider;
  readonly createProxyFetch?: typeof createProxyFetch;
};

export type ProviderRuntime = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly ProviderRuntimeSummary[];
};

export type ProviderRuntimeSummary = Omit<DashboardProviderSummary, 'state'>;

export function materializeRuntimeProvider(
  provider: RuntimeProviderInput,
  options: { readonly apiBridge?: AiSdkProviderInstance } = {},
): RuntimeProviderInstance {
  if (isMaterializedRuntimeProvider(provider)) {
    if (provider.capabilityIndex !== undefined) return provider;
    return {
      ...provider,
      capabilityIndex: capabilityIndexFromRoutable({
        models: provider.models,
        alias: provider.alias,
        metadata: provider.configMetadata,
        primaryProtocol: 'protocol' in provider ? provider.protocol : undefined,
      }),
    };
  }

  const { apiBridge } = options;
  if (provider.kind === ProviderKind.Api) {
    const [primary, ...rest] = provider.endpointTransports;
    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      ...routingDefaults(provider),
      ...(provider.models === undefined ? {} : { models: provider.models }),
      ...(provider.alias === undefined ? {} : { alias: provider.alias }),
      ...(provider.metadata === undefined ? {} : { configMetadata: provider.metadata }),
      capabilityIndex: capabilityIndexFromRoutable({
        models: provider.models,
        alias: provider.alias,
        metadata: provider.metadata,
        primaryProtocol: primary.protocol,
        extraProtocols: rest.map((endpoint) => endpoint.protocol),
      }),
      hasApiKey: provider.apiKey !== undefined,
      raw: {
        resolve: ({ protocol }) => {
          const transport = provider.endpointTransports.find((endpoint) => endpoint.protocol === protocol);
          return transport === undefined
            ? undefined
            : { invoke: (request, _context, options) => transport.passthrough(request, options) };
        },
      },
      ...(apiBridge === undefined
        ? {}
        : {
            model: {
              ...(apiBridge.ensureAvailable === undefined ? {} : { ensureAvailable: apiBridge.ensureAvailable }),
              invoke: apiBridge.invoke,
              ...(apiBridge.targetProtocol === undefined ? {} : { targetProtocol: () => apiBridge.targetProtocol }),
            },
          }),
      ...embeddingTransport(apiBridge),
    };
  }

  if (provider.kind === ProviderKind.AiSdk) {
    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      ...(provider.models === undefined ? {} : { models: provider.models }),
      ...(provider.alias === undefined ? {} : { alias: provider.alias }),
      ...(provider.metadata === undefined ? {} : { configMetadata: provider.metadata }),
      capabilityIndex: capabilityIndexFromRoutable({
        models: provider.models,
        alias: provider.alias,
        metadata: provider.metadata,
        primaryProtocol: provider.targetProtocol,
      }),
      model: {
        ...(provider.ensureAvailable === undefined ? {} : { ensureAvailable: provider.ensureAvailable }),
        invoke: provider.invoke,
        ...(provider.targetProtocol === undefined ? {} : { targetProtocol: () => provider.targetProtocol }),
      },
      ...embeddingTransport(provider),
    };
  }

  throw new TypeError('Runtime provider must expose a raw, model, image, or embedding capability');
}

function isMaterializedRuntimeProvider(provider: RuntimeProviderInput): provider is RuntimeProviderInstance {
  const raw = Object.hasOwn(provider, 'raw') ? (provider as { readonly raw?: unknown }).raw : undefined;
  const model = Object.hasOwn(provider, 'model') ? (provider as { readonly model?: unknown }).model : undefined;
  const image = Object.hasOwn(provider, 'image') ? (provider as { readonly image?: unknown }).image : undefined;
  const embedding = Object.hasOwn(provider, 'embedding')
    ? (provider as { readonly embedding?: unknown }).embedding
    : undefined;
  if (raw !== undefined && !isRuntimeRawCapability(raw)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid raw capability`);
  }
  if (model !== undefined && !isModelTransport(model)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid model capability`);
  }
  if (image !== undefined && !isImageTransport(image)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid image capability`);
  }
  if (embedding !== undefined && !isEmbeddingTransport(embedding)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid embedding capability`);
  }
  return raw !== undefined || model !== undefined || image !== undefined || embedding !== undefined;
}

function isRuntimeRawCapability(value: unknown): value is RuntimeRawCapability {
  return typeof value === 'object' && value !== null && 'resolve' in value && typeof value.resolve === 'function';
}

function isModelTransport(value: unknown): value is ModelTransport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    (!('ensureAvailable' in value) ||
      value.ensureAvailable === undefined ||
      typeof value.ensureAvailable === 'function') &&
    (!('targetProtocol' in value) || value.targetProtocol === undefined || typeof value.targetProtocol === 'function')
  );
}

function isImageTransport(value: unknown): value is ImageTransport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof value.invoke === 'function' &&
    (!('ensureAvailable' in value) ||
      value.ensureAvailable === undefined ||
      typeof value.ensureAvailable === 'function')
  );
}

function isEmbeddingTransport(value: unknown): value is EmbeddingTransport {
  return typeof value === 'object' && value !== null && 'embed' in value && typeof value.embed === 'function';
}

function embeddingTransport(
  source: { readonly embed?: EmbeddingTransport['embed'] } | undefined,
): { readonly embedding: EmbeddingTransport } | Record<never, never> {
  return source?.embed === undefined ? {} : { embedding: { embed: source.embed } };
}

function capabilityIndexFromRoutable(provider: {
  readonly models?: readonly string[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly metadata?: Readonly<Record<string, ModelMetadata>>;
  readonly primaryProtocol?: ProviderProtocol;
  readonly extraProtocols?: readonly ProviderProtocol[];
}): ModelCapabilityIndex {
  return buildModelCapabilityIndex({
    models: provider.models,
    metadata: provider.metadata,
    primaryProtocol: provider.primaryProtocol,
    extraProtocols: provider.extraProtocols,
    aliasTargets: provider.alias === undefined ? undefined : aliasTargets(provider.alias),
  });
}

function aliasTargets(alias: Readonly<Record<string, AliasConfig>>): string[] {
  return [...new Set(Object.values(alias).flatMap(aliasTargetModels))];
}

/** `false` disables the top-level proxy for this provider; omitted inherits it. */
export function effectiveProxy(
  globalProxy: string | undefined,
  providerProxy: string | false | undefined,
): string | undefined {
  if (providerProxy === false) return undefined;
  return providerProxy ?? globalProxy;
}

export function materializeProviders(config: Config, options: MaterializeProvidersOptions = {}): ProviderRuntime {
  const bridgeApiProvider = options.bridgeApiProvider ?? bridgeApiProviderToAiSdk;
  const createApi = options.createApiProvider ?? createApiProvider;
  const createAiSdk = options.createAiSdkProvider ?? createAiSdkProvider;
  const createFetch = options.createProxyFetch ?? createProxyFetch;
  const probes = new Map<string, ProviderProbe>();
  const providers: RuntimeProviderInstance[] = [];
  const summaries: ProviderRuntimeSummary[] = [];
  for (const provider of config.providers) {
    const id = providerId(provider);
    if (!provider.enabled) {
      summaries.push(providerConfigSummary(provider));
      continue;
    }

    switch (provider.kind) {
      case ProviderKind.Api: {
        const providerFetch = createProviderRequestTransformFetch(
          provider,
          createObservedFetch(createFetch(effectiveProxy(config.proxy, provider.proxy))),
        );
        const api = createApi(provider, { fetch: providerFetch });
        const primaryProtocol = apiProviderEndpoints(provider)[0].protocol;
        const instance = withRoutingDefaults(
          attachImageTransport(
            materializeRuntimeProvider(api, {
              ...(primaryProtocol === ProviderProtocol.OpenAIImage
                ? {}
                : { apiBridge: bridgeApiProvider(provider, { fetch: providerFetch }) }),
            }),
            { config: provider, fetch: providerFetch },
          ),
          provider,
        );
        probes.set(id, () => probeApi(provider, api));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name, provider));
        break;
      }
      case ProviderKind.AiSdk: {
        const providerFetch = createProviderRequestTransformFetch(
          provider,
          createObservedFetch(createFetch(effectiveProxy(config.proxy, provider.proxy))),
        );
        const aiSdk = createAiSdk(provider, { fetch: providerFetch });
        const instance = withRoutingDefaults(
          attachImageTransport(materializeRuntimeProvider(aiSdk), { config: provider, fetch: providerFetch }),
          provider,
        );
        probes.set(id, () => probeAiSdk(aiSdk));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name, provider));
        break;
      }
      case ProviderKind.OAuth: {
        summaries.push(providerConfigSummary(provider));
        break;
      }
      default:
        assertNever(provider);
    }
  }

  return {
    probes,
    providers,
    summaries,
  };
}

export function providerSummary(
  provider: RuntimeProviderInstance,
  name?: string,
  config?: Provider,
): ProviderRuntimeSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.raw !== undefined,
    last_status: 'unknown',
    last_latency: null,
    // Runtime factories don't carry `name`, so callers pass the config display name through.
    ...(name === undefined ? {} : { name }),
    ...(config === undefined ? {} : providerDisplayFields(config)),
    clientModels: [...new Set(modelRoutes(provider).map((route) => route.alias))],
    hasApiKey: provider.kind === ProviderKind.Api ? provider.hasApiKey : undefined,
  };
}

export function providerDiff(
  before: readonly Pick<DashboardProviderSummary, 'id'>[],
  after: readonly Pick<DashboardProviderSummary, 'id'>[],
) {
  const beforeIds = new Set(before.map((provider) => provider.id));
  const afterIds = new Set(after.map((provider) => provider.id));
  return {
    providerIds: {
      added: after.filter((provider) => !beforeIds.has(provider.id)).map((provider) => provider.id),
      removed: before.filter((provider) => !afterIds.has(provider.id)).map((provider) => provider.id),
    },
  };
}

function providerId(provider: Provider): string {
  return provider.id;
}

function providerConfigSummary(provider: Provider): ProviderRuntimeSummary {
  const clientModels = [...new Set(modelRoutes(provider).map((route) => route.alias))];
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.kind === ProviderKind.Api,
    last_status: 'unknown',
    last_latency: null,
    name: provider.name,
    ...providerDisplayFields(provider),
    clientModels,
    hasApiKey: provider.kind === ProviderKind.Api ? provider.apiKey !== undefined : undefined,
  };
}

function providerDisplayFields(
  provider: Provider,
): Pick<ProviderRuntimeSummary, 'priority' | 'weight' | 'protocol' | 'packageName'> {
  return {
    ...routingDefaults(provider),
    ...(provider.kind === ProviderKind.Api ? { protocol: apiProviderEndpoints(provider)[0].protocol } : {}),
    ...(provider.kind === ProviderKind.AiSdk ? { packageName: provider.packageName } : {}),
  };
}

function routingDefaults(provider: { readonly priority?: number; readonly weight?: number }): {
  readonly priority?: number;
  readonly weight?: number;
} {
  return {
    ...(provider.priority === undefined ? {} : { priority: provider.priority }),
    ...(provider.weight === undefined ? {} : { weight: provider.weight }),
  };
}

function withRoutingDefaults(
  instance: RuntimeProviderInstance,
  provider: Pick<Provider, 'priority' | 'weight'>,
): RuntimeProviderInstance {
  return { ...instance, ...routingDefaults(provider) };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
