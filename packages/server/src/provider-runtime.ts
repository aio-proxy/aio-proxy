import { createAiSdkProvider, createApiProvider } from "@aio-proxy/core";
import type { Config, DashboardProviderProbe, DashboardProviderSummary, Provider } from "@aio-proxy/types";
import { ProviderKind, ProviderProtocol } from "@aio-proxy/types";
import { createOAuthRuntimeProvider } from "./oauth-runtime";
import type { RuntimeProviderInstance } from "./runtime";

export type ProviderProbe = () => Promise<DashboardProviderProbe>;

export type ProviderRuntime = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
};

export function materializeProviders(config: Config): ProviderRuntime {
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
        probes.set(id, () => probeApi(provider, provider.baseUrl));
        const instance = createApiProvider(provider);
        providers.push(instance);
        summaries.push(providerSummary(instance));
        break;
      }
      case ProviderKind.AiSdk: {
        const instance = createAiSdkProvider(provider);
        probes.set(id, () => probeAiSdk(instance));
        providers.push(instance);
        summaries.push(providerSummary(instance));
        break;
      }
      case ProviderKind.OAuth: {
        const instance = createOAuthRuntimeProvider(provider);
        probes.set(id, () => probeAiSdk(instance));
        providers.push(instance);
        summaries.push(providerSummary(instance));
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

export function providerSummary(provider: RuntimeProviderInstance): DashboardProviderSummary {
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: isPassthrough(provider),
    last_status: "unknown",
    last_latency: null,
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
  return {
    id: provider.id,
    kind: provider.kind,
    enabled: provider.enabled,
    passthrough: provider.kind === ProviderKind.Api,
    last_status: "unknown",
    last_latency: null,
  };
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

function isPassthrough(provider: RuntimeProviderInstance): boolean {
  return provider.kind === ProviderKind.Api;
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
