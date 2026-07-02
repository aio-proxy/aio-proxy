import { createAiSdkProvider, createApiProvider } from "@aio-proxy/core";
import type {
  Config,
  DashboardProviderProbe,
  DashboardProviderSummary,
  Provider,
} from "@aio-proxy/types";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import type { RuntimeProviderInstance } from "./runtime";

export type ProviderProbe = () => Promise<DashboardProviderProbe>;

export type ProviderRuntime = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
};

export function materializeProviders(config: Config): ProviderRuntime {
  const probes = new Map<string, ProviderProbe>();
  const providers = config.providers.map((provider) => {
    const id = providerId(provider);
    switch (provider.kind) {
      case ProviderKind.Api: {
        const baseUrl = provider.baseUrl;
        if (baseUrl === undefined) {
          throw new ProviderBuildError(id, "api provider requires baseUrl");
        }
        probes.set(id, () => probeApi(provider, baseUrl));
        return createApiProvider({ ...provider, id, baseUrl });
      }
      case ProviderKind.AiSdk: {
        const instance = createAiSdkProvider(provider);
        probes.set(id, () => probeAiSdk(instance));
        return instance;
      }
      case ProviderKind.Subscription:
        return {
          id,
          kind: provider.kind,
          ...(provider.models === undefined ? {} : { models: provider.models }),
          vendor: provider.vendor,
        };
      default:
        return assertNever(provider);
    }
  });

  return {
    probes,
    providers,
    summaries: providers.map((provider) => providerSummary(provider)),
  };
}

export function providerSummary(
  provider: RuntimeProviderInstance,
): DashboardProviderSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: true,
    passthrough: isPassthrough(provider),
    last_status: "unknown",
    last_latency: null,
  };
}

export function providerDiff(
  before: readonly DashboardProviderSummary[],
  after: readonly DashboardProviderSummary[],
) {
  const beforeIds = new Set(before.map((provider) => provider.id));
  const afterIds = new Set(after.map((provider) => provider.id));
  return {
    providerIds: {
      added: after
        .filter((provider) => !beforeIds.has(provider.id))
        .map((provider) => provider.id),
      removed: before
        .filter((provider) => !afterIds.has(provider.id))
        .map((provider) => provider.id),
    },
  };
}

export class ProviderBuildError extends Error {
  override readonly name = "ProviderBuildError";

  constructor(
    readonly providerId: string,
    message: string,
  ) {
    super(`${providerId}: ${message}`);
  }
}

function providerId(provider: Provider): string {
  switch (provider.kind) {
    case ProviderKind.Api:
      return provider.id ?? provider.protocol;
    case ProviderKind.AiSdk:
    case ProviderKind.Subscription:
      return provider.id;
    default:
      return assertNever(provider);
  }
}

async function probeApi(
  provider: Extract<Provider, { kind: ProviderKind.Api }>,
  baseUrl: string,
): Promise<DashboardProviderProbe> {
  try {
    const request = providerProbeRequest(provider, baseUrl);
    const response = await fetch(request.url, {
      body: JSON.stringify(request.body),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(1_000),
    });
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
  baseUrl: string,
): { readonly body: unknown; readonly url: URL } {
  const model = "aio-proxy-probe";
  const url = new URL(baseUrl);
  switch (provider.protocol) {
    case ProviderProtocol.OpenAICompatible:
      url.pathname = "/v1/chat/completions";
      return {
        body: { messages: [{ role: "user", content: "ping" }], model },
        url,
      };
    case ProviderProtocol.OpenAIResponse:
      url.pathname = "/v1/responses";
      return { body: { input: "ping", model }, url };
    case ProviderProtocol.Anthropic:
      url.pathname = "/v1/messages";
      return {
        body: {
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
          model,
        },
        url,
      };
    case ProviderProtocol.Gemini:
      url.pathname = `/v1beta/models/${model}:generateContent`;
      return {
        body: { contents: [{ role: "user", parts: [{ text: "ping" }] }] },
        url,
      };
    default:
      return assertNever(provider.protocol);
  }
}

async function probeAiSdk(
  provider: Extract<RuntimeProviderInstance, { kind: ProviderKind.AiSdk }>,
): Promise<DashboardProviderProbe> {
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

function isPassthrough(provider: RuntimeProviderInstance): boolean {
  return provider.kind === ProviderKind.Api;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
