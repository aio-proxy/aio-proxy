import { createAiSdkProvider, createApiProvider } from "@aio-proxy/core";
import type {
  Config,
  DashboardProviderProbe,
  DashboardProviderSummary,
  Provider,
} from "@aio-proxy/types";
import type { RuntimeProviderInstance } from "./runtime";

export type ProviderProbe = () => Promise<DashboardProviderProbe>;

export type ProviderRuntime = {
  readonly providers: readonly RuntimeProviderInstance[];
  readonly probes: ReadonlyMap<string, ProviderProbe>;
  readonly summaries: readonly DashboardProviderSummary[];
};

const passthroughVendors = new Set([
  "openai-native",
  "anthropic-native",
  "google-native",
]);

export function materializeProviders(config: Config): ProviderRuntime {
  const probes = new Map<string, ProviderProbe>();
  const providers = config.providers.map((provider) => {
    const id = providerId(provider);
    switch (provider.kind) {
      case "api": {
        const baseUrl = provider.baseUrl;
        if (baseUrl === undefined) {
          throw new ProviderBuildError(id, "api provider requires baseUrl");
        }
        probes.set(id, () => probeApi(baseUrl));
        return createApiProvider({ ...provider, id, baseUrl });
      }
      case "ai-sdk": {
        const instance = createAiSdkProvider(provider);
        probes.set(id, () => probeAiSdk(instance));
        return instance;
      }
      case "subscription":
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
    case "api":
      return provider.id ?? provider.vendor;
    case "ai-sdk":
    case "subscription":
      return provider.id;
    default:
      return assertNever(provider);
  }
}

async function probeApi(baseUrl: string): Promise<DashboardProviderProbe> {
  const started = performance.now();
  try {
    await fetch(baseUrl, {
      method: "HEAD",
      signal: AbortSignal.timeout(1_000),
    });
    return performance.now() - started >= 0 ? "OK" : "FAIL";
  } catch (error) {
    if (error instanceof Error) {
      return "FAIL";
    }
    throw error;
  }
}

async function probeAiSdk(
  provider: Extract<RuntimeProviderInstance, { kind: "ai-sdk" }>,
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
  return provider.kind === "api" && passthroughVendors.has(provider.vendor);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported provider: ${String(value)}`);
}
