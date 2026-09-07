import {
  type AiSdkProviderInstance,
  bridgeApiProviderToAiSdk,
  createAiSdkProvider,
  createApiProvider,
  createProxyFetch,
  hasLanguageBridgeEndpoint,
} from '@aio-proxy/core';
import type { AliasConfig, Config, ModelMetadata } from '@aio-proxy/types';
import { aliasTargetModels, apiProviderEndpoints, ProviderKind, ProviderProtocol } from '@aio-proxy/types';
import { uniq } from 'es-toolkit/array';

import { createProviderRequestTransformFetch } from '../../provider-request-transform';
import { createObservedFetch } from '../../request-logging';
import type { ModelCapabilityIndex, RuntimeProviderInput, RuntimeProviderInstance } from '../../runtime';
import { buildModelCapabilityIndex } from '../capability-index';
import { attachAudioTransports } from '../materialize-audio';
import { attachImageTransport } from '../materialize-image';
import { probeAiSdk, probeApi, type ProviderProbe } from '../probe';
import {
  providerConfigSummary,
  type ProviderRuntimeSummary,
  providerSummary,
  routingDefaults,
  withRoutingDefaults,
} from './provider-summary';
import { embeddingTransport, isMaterializedRuntimeProvider } from './transport-guards';

export type MaterializeProvidersOptions = {
  readonly bridgeApiProvider?: typeof bridgeApiProviderToAiSdk;
  readonly createApiProvider?: typeof createApiProvider;
  readonly createAiSdkProvider?: typeof createAiSdkProvider;
  readonly createProxyFetch?: typeof createProxyFetch;
  /** models.dev fallback metadata by upstream model id; see `CapabilityIndexInput.catalogMetadata`. */
  readonly catalogMetadata?: Readonly<Record<string, ModelMetadata | undefined>>;
};

export type ProviderRuntime = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly ProviderRuntimeSummary[];
};

export function materializeRuntimeProvider(
  provider: RuntimeProviderInput,
  options: {
    readonly apiBridge?: AiSdkProviderInstance;
    readonly catalogMetadata?: Readonly<Record<string, ModelMetadata | undefined>>;
  } = {},
): RuntimeProviderInstance {
  const { catalogMetadata } = options;
  if (isMaterializedRuntimeProvider(provider)) {
    if (provider.capabilityIndex !== undefined) return provider;
    return {
      ...provider,
      capabilityIndex: capabilityIndexFromRoutable({
        models: provider.models,
        alias: provider.alias,
        catalogMetadata,
        // Legacy API provider instances carry a primary protocol; the
        // materialized runtime type does not declare it.
        primaryProtocol:
          'protocol' in provider ? (provider as { readonly protocol?: ProviderProtocol }).protocol : undefined,
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
      capabilityIndex: capabilityIndexFromRoutable({
        models: provider.models,
        alias: provider.alias,
        catalogMetadata,
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
      capabilityIndex: capabilityIndexFromRoutable({
        models: provider.models,
        alias: provider.alias,
        catalogMetadata,
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

  throw new TypeError(
    'Runtime provider must expose a raw, model, image, embedding, speech, or transcription capability',
  );
}

function capabilityIndexFromRoutable(provider: {
  readonly models?: readonly string[];
  readonly alias?: Readonly<Record<string, AliasConfig>>;
  readonly primaryProtocol?: ProviderProtocol;
  readonly extraProtocols?: readonly ProviderProtocol[];
  readonly catalogMetadata?: Readonly<Record<string, ModelMetadata | undefined>>;
}): ModelCapabilityIndex {
  return buildModelCapabilityIndex({
    models: provider.models,
    primaryProtocol: provider.primaryProtocol,
    extraProtocols: provider.extraProtocols,
    catalogMetadata: provider.catalogMetadata,
    aliasTargets: provider.alias === undefined ? undefined : aliasTargets(provider.alias),
  });
}

function aliasTargets(alias: Readonly<Record<string, AliasConfig>>): string[] {
  return uniq(Object.values(alias).flatMap(aliasTargetModels));
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
    const id = provider.id;
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
        const endpoints = apiProviderEndpoints(provider);
        const hasLanguageEndpoint = hasLanguageBridgeEndpoint(endpoints);
        const instance = withRoutingDefaults(
          attachAudioTransports(
            attachImageTransport(
              materializeRuntimeProvider(api, {
                catalogMetadata: options.catalogMetadata,
                ...(hasLanguageEndpoint ? { apiBridge: bridgeApiProvider(provider, { fetch: providerFetch }) } : {}),
              }),
              { config: provider, fetch: providerFetch, routerModels: config.router.models },
            ),
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
          attachAudioTransports(
            attachImageTransport(materializeRuntimeProvider(aiSdk, { catalogMetadata: options.catalogMetadata }), {
              config: provider,
              fetch: providerFetch,
              routerModels: config.router.models,
            }),
            { config: provider, fetch: providerFetch },
          ),
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

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
