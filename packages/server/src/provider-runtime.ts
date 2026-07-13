import {
  type AiSdkProviderInstance,
  type ApiProviderInstance,
  bridgeApiProviderToAiSdk,
  createAiSdkProvider,
  createApiProvider,
  modelRoutes,
} from "@aio-proxy/core";
import type { Config, DashboardProviderProbe, DashboardProviderSummary, Provider } from "@aio-proxy/types";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { createOAuthRuntimeProvider } from "./oauth-runtime";
import type { RuntimeProviderInput, RuntimeProviderInstance } from "./runtime";

export type ProviderProbe = () => Promise<DashboardProviderProbe>;

export type MaterializeProvidersOptions = {
  readonly bridgeApiProvider?: typeof bridgeApiProviderToAiSdk;
};

const probeMaxOutputTokens = 1;
const openAIResponsesProbeMaxOutputTokens = 16;

export type ProviderRuntime = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
};

export function materializeRuntimeProvider(
  provider: RuntimeProviderInput,
  options: { readonly apiBridge?: AiSdkProviderInstance } = {},
): RuntimeProviderInstance {
  if (isMaterializedRuntimeProvider(provider)) {
    return provider;
  }

  if (provider.kind === ProviderKind.Api) {
    return {
      ...provider,
      raw: { protocol: provider.protocol, invoke: provider.passthrough },
      ...(options.apiBridge === undefined
        ? {}
        : {
            model: {
              ...(options.apiBridge.ensureAvailable === undefined
                ? {}
                : { ensureAvailable: options.apiBridge.ensureAvailable }),
              invoke: options.apiBridge.invoke,
            },
          }),
    };
  }

  return {
    ...provider,
    model: {
      ...(provider.ensureAvailable === undefined ? {} : { ensureAvailable: provider.ensureAvailable }),
      invoke: provider.invoke,
    },
  };
}

function isMaterializedRuntimeProvider(provider: RuntimeProviderInput): provider is RuntimeProviderInstance {
  return (
    ("raw" in provider && Object.hasOwn(provider, "raw") && provider.raw !== undefined) ||
    ("model" in provider && Object.hasOwn(provider, "model") && provider.model !== undefined)
  );
}

export function materializeProviders(config: Config, options: MaterializeProvidersOptions = {}): ProviderRuntime {
  const bridgeApiProvider = options.bridgeApiProvider ?? bridgeApiProviderToAiSdk;
  const probes = new Map<string, ProviderProbe>();
  const providers: RuntimeProviderInstance[] = [];
  const summaries: DashboardProviderSummary[] = [];
  for (const provider of config.providers) {
    const id = providerId(provider);
    if (!provider.enabled) {
      summaries.push(providerConfigSummary(provider));
      continue;
    }

    switch (provider.kind) {
      case ProviderKind.Api: {
        const api = createApiProvider(provider);
        const instance = materializeRuntimeProvider(api, { apiBridge: bridgeApiProvider(provider) });
        probes.set(id, () => probeApi(provider, api));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name));
        break;
      }
      case ProviderKind.AiSdk: {
        const aiSdk = createAiSdkProvider(provider);
        const instance = materializeRuntimeProvider(aiSdk);
        probes.set(id, () => probeAiSdk(aiSdk));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name));
        break;
      }
      case ProviderKind.OAuth: {
        const oauth = createOAuthRuntimeProvider(provider);
        const instance = materializeRuntimeProvider(oauth);
        probes.set(id, () => probeAiSdk(oauth));
        providers.push(instance);
        summaries.push(providerSummary(instance, provider.name));
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

export function providerSummary(provider: RuntimeProviderInstance, name?: string): DashboardProviderSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.raw !== undefined,
    last_status: "unknown",
    last_latency: null,
    // Runtime factories don't carry `name`, so callers pass the config display name through.
    name: name ?? ("name" in provider ? provider.name : undefined),
    clientModels: [...new Set(modelRoutes(provider).map((route) => route.alias))],
    hasApiKey: provider.kind === ProviderKind.Api ? provider.apiKey !== undefined : undefined,
  };
}

export function providerDiff(before: readonly DashboardProviderSummary[], after: readonly DashboardProviderSummary[]) {
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

function providerConfigSummary(provider: Provider): DashboardProviderSummary {
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

async function probeApi(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  instance: ApiProviderInstance,
): Promise<DashboardProviderProbe> {
  try {
    const model = providerProbeModel(provider);
    if (model === undefined) {
      return "FAIL";
    }
    const request = providerProbeRequest(provider, model);
    const response = await instance.passthrough(
      new Request(request.url, {
        body: JSON.stringify(request.body),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(1_000),
      }),
    );
    if (response.body !== null) {
      await response.body.cancel();
    }
    return response.ok ? "OK" : "FAIL";
  } catch (error) {
    if (error instanceof Error) {
      return "FAIL";
    }
    throw error;
  }
}

function providerProbeRequest(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  model: string,
): { readonly body: unknown; readonly url: URL } {
  const url = new URL(provider.baseUrl);
  switch (provider.protocol) {
    case ProviderProtocol.OpenAICompatible:
      url.pathname = "/v1/chat/completions";
      return {
        body: { max_tokens: probeMaxOutputTokens, messages: [{ role: "user", content: "ping" }], model },
        url,
      };
    case ProviderProtocol.OpenAIResponse:
      url.pathname = "/v1/responses";
      return { body: { input: "ping", max_output_tokens: openAIResponsesProbeMaxOutputTokens, model }, url };
    case ProviderProtocol.Anthropic:
      url.pathname = "/v1/messages";
      return {
        body: {
          max_tokens: probeMaxOutputTokens,
          messages: [{ role: "user", content: "ping" }],
          model,
        },
        url,
      };
    case ProviderProtocol.Gemini:
      url.pathname = `/v1beta/models/${model}:generateContent`;
      return {
        body: {
          contents: [{ role: "user", parts: [{ text: "ping" }] }],
          generationConfig: { maxOutputTokens: probeMaxOutputTokens },
        },
        url,
      };
    default:
      return assertNever(provider.protocol);
  }
}

function providerProbeModel(provider: Extract<Provider, { kind: ProviderKind.Api }>): string | undefined {
  const aliasTarget = provider.alias === undefined ? undefined : Object.values(provider.alias)[0]?.model;
  return aliasTarget ?? provider.models?.[0];
}

async function probeAiSdk(provider: {
  readonly ensureAvailable?: () => Promise<void>;
}): Promise<DashboardProviderProbe> {
  if (provider.ensureAvailable === undefined) {
    return "OK";
  }

  try {
    await provider.ensureAvailable();
    return "OK";
  } catch (error) {
    if (error instanceof Error) {
      return "FAIL";
    }
    throw error;
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
