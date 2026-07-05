import type { RouterResolution } from "@aio-proxy/core";
import { bridgeApiProviderToAiSdk, RouterModelNotFoundError } from "@aio-proxy/core";
import { ProviderKind } from "@aio-proxy/types";
import type { ProviderRouteSource, RuntimeProviderInstance } from "./runtime";

export function resolveCandidates(
  source: ProviderRouteSource,
  model: string,
): readonly RouterResolution<RuntimeProviderInstance>[] | RouterModelNotFoundError {
  try {
    return source.currentProviderSnapshot().router.resolve(model);
  } catch (error) {
    if (error instanceof RouterModelNotFoundError) {
      return error;
    }
    throw error;
  }
}

export function shouldTryNextResponse(response: Response): boolean {
  return response.status === 429 || response.status >= 500;
}

export function toAiSdkProvider(provider: RuntimeProviderInstance) {
  if (provider.kind === ProviderKind.AiSdk) {
    return provider;
  }

  if (provider.kind === ProviderKind.Api) {
    return bridgeApiProviderToAiSdk({
      ...(provider.apiKey === undefined ? {} : { apiKey: provider.apiKey }),
      baseUrl: provider.baseUrl,
      enabled: provider.enabled,
      id: provider.id,
      kind: provider.kind,
      ...(provider.models === undefined ? {} : { models: [...provider.models] }),
      protocol: provider.protocol,
    });
  }

  return undefined;
}
