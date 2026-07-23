import type { Config, DashboardProviderSummary, Provider } from "@aio-proxy/types";

import {
  type AiSdkProviderInstance,
  bridgeApiProviderToAiSdk,
  createAiSdkProvider,
  createApiProvider,
  createProxyFetch,
  modelRoutes,
} from "@aio-proxy/core";
import { ProviderKind } from "@aio-proxy/types";

import type { ModelTransport, RuntimeProviderInput, RuntimeProviderInstance, RuntimeRawCapability } from "../runtime";

import { probeAiSdk, probeApi, type ProviderProbe } from "./probe";

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

export type ProviderRuntimeSummary = Omit<DashboardProviderSummary, "state">;

export function materializeRuntimeProvider(
  provider: RuntimeProviderInput,
  options: { readonly apiBridge?: AiSdkProviderInstance } = {},
): RuntimeProviderInstance {
  if (isMaterializedRuntimeProvider(provider)) {
    return provider;
  }

  if (provider.kind === ProviderKind.Api) {
    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      ...(provider.models === undefined ? {} : { models: provider.models }),
      ...(provider.alias === undefined ? {} : { alias: provider.alias }),
      hasApiKey: provider.apiKey !== undefined,
      raw: {
        resolve: ({ protocol }) => (protocol === provider.protocol ? { invoke: provider.passthrough } : undefined),
      },
      ...(options.apiBridge === undefined
        ? {}
        : {
            model: {
              ...(options.apiBridge.ensureAvailable === undefined
                ? {}
                : { ensureAvailable: options.apiBridge.ensureAvailable }),
              invoke: options.apiBridge.invoke,
              ...(options.apiBridge.targetProtocol === undefined
                ? {}
                : { targetProtocol: () => options.apiBridge.targetProtocol }),
            },
          }),
    };
  }

  if (provider.kind === ProviderKind.AiSdk) {
    return {
      id: provider.id,
      kind: provider.kind,
      enabled: provider.enabled,
      ...(provider.models === undefined ? {} : { models: provider.models }),
      ...(provider.alias === undefined ? {} : { alias: provider.alias }),
      model: {
        ...(provider.ensureAvailable === undefined ? {} : { ensureAvailable: provider.ensureAvailable }),
        invoke: provider.invoke,
        ...(provider.targetProtocol === undefined ? {} : { targetProtocol: () => provider.targetProtocol }),
      },
    };
  }

  throw new TypeError("Runtime provider must expose a raw or model capability");
}

function isMaterializedRuntimeProvider(provider: RuntimeProviderInput): provider is RuntimeProviderInstance {
  const raw = Object.hasOwn(provider, "raw") ? (provider as { readonly raw?: unknown }).raw : undefined;
  const model = Object.hasOwn(provider, "model") ? (provider as { readonly model?: unknown }).model : undefined;
  if (raw !== undefined && !isRuntimeRawCapability(raw)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid raw capability`);
  }
  if (model !== undefined && !isModelTransport(model)) {
    throw new TypeError(`Runtime provider ${provider.id} has an invalid model capability`);
  }
  return raw !== undefined || model !== undefined;
}

function isRuntimeRawCapability(value: unknown): value is RuntimeRawCapability {
  return typeof value === "object" && value !== null && "resolve" in value && typeof value.resolve === "function";
}

function isModelTransport(value: unknown): value is ModelTransport {
  return (
    typeof value === "object" &&
    value !== null &&
    "invoke" in value &&
    typeof value.invoke === "function" &&
    (!("ensureAvailable" in value) ||
      value.ensureAvailable === undefined ||
      typeof value.ensureAvailable === "function") &&
    (!("targetProtocol" in value) || value.targetProtocol === undefined || typeof value.targetProtocol === "function")
  );
}

/** `false` disables the top-level proxy for this provider; omitted inherits it. */
function effectiveProxy(
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
        const providerFetch = createFetch(effectiveProxy(config.proxy, provider.proxy));
        const api = createApi(provider, { fetch: providerFetch });
        const instance = materializeRuntimeProvider(api, {
          apiBridge: bridgeApiProvider(provider, { fetch: providerFetch }),
        });
        probes.set(id, () => probeApi(provider, api));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name));
        break;
      }
      case ProviderKind.AiSdk: {
        const providerFetch = createFetch(effectiveProxy(config.proxy, provider.proxy));
        const aiSdk = createAiSdk(provider, { fetch: providerFetch });
        const instance = materializeRuntimeProvider(aiSdk);
        probes.set(id, () => probeAiSdk(aiSdk));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name));
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

export function providerSummary(provider: RuntimeProviderInstance, name?: string): ProviderRuntimeSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.raw !== undefined,
    last_status: "unknown",
    last_latency: null,
    // Runtime factories don't carry `name`, so callers pass the config display name through.
    ...(name === undefined ? {} : { name }),
    clientModels: [...new Set(modelRoutes(provider).map((route) => route.alias))],
    hasApiKey: provider.kind === ProviderKind.Api ? provider.hasApiKey : undefined,
  };
}

export function providerDiff(
  before: readonly Pick<DashboardProviderSummary, "id">[],
  after: readonly Pick<DashboardProviderSummary, "id">[],
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
    last_status: "unknown",
    last_latency: null,
    name: provider.name,
    clientModels,
    hasApiKey: provider.kind === ProviderKind.Api ? provider.apiKey !== undefined : undefined,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
